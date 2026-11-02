import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createSimulation,
  HOUR,
  MINUTE,
  SCENARIO_SIZE,
  type SimAction,
} from "../src/index.ts";

const engineWork: fc.Arbitrary<SimAction> = fc.oneof(
  fc.constant<SimAction>({ tag: "dispatch" }),
  fc.integer({ min: 1, max: 4 }).map((limit): SimAction => ({ tag: "send", limit })),
  fc.constant<SimAction>({ tag: "timers" }),
  fc.constant<SimAction>({ tag: "parallel" }),
);

const world: fc.Arbitrary<SimAction> = fc.oneof(
  fc.nat(SCENARIO_SIZE - 1).map((index): SimAction => ({ tag: "deliver", index })),
  fc.integer({ min: 1, max: 10 * MINUTE }).map((ms): SimAction => ({ tag: "advance", ms })),
);

const faults: fc.Arbitrary<SimAction> = fc.oneof(
  fc
    .tuple(fc.constantFrom("before" as const, "after" as const), fc.nat(4))
    .map(([timing, skip]): SimAction => ({ tag: "crash", timing, skip })),
  fc.constantFrom("transient" as const, "permanent" as const, "ambiguous" as const).map(
    (script): SimAction => ({ tag: "gatewayFault", script }),
  ),
);

const schedule = (...parts: readonly fc.Arbitrary<SimAction>[]) =>
  fc.array(fc.oneof(...parts), { minLength: 10, maxLength: 80 });

const runSchedule = async (actions: readonly SimAction[]) => {
  const simulation = createSimulation();
  for (const action of actions) {
    await simulation.perform(action);
    await simulation.checkSafety();
  }
  await simulation.drain();
  await simulation.checkFinal();
  return simulation;
};

describe("the system under an adversarial schedule", () => {
  it("keeps every guarantee through crashes, faults, duplicates and reordering", async () => {
    await fc.assert(
      fc.asyncProperty(schedule(engineWork, world, faults), async (actions) => {
        await runSchedule(actions);
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it("sends each message exactly once when nothing goes wrong", async () => {
    await fc.assert(
      fc.asyncProperty(schedule(engineWork, world), async (actions) => {
        const simulation = await runSchedule(actions);
        expect(simulation.wasFaultFree()).toBe(true);
        const keys = simulation.harness.gateway.sent.map((message) => message.key);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it("really does exercise the flow", async () => {
    let completed = 0;
    let crashedRuns = 0;
    await fc.assert(
      fc.asyncProperty(schedule(engineWork, world, faults), async (actions) => {
        const simulation = await runSchedule(actions);
        const { sent } = simulation.harness.gateway;
        if (sent.some((message) => message.action.text.includes("https://"))) completed += 1;
        if (!simulation.wasFaultFree()) crashedRuns += 1;
      }),
      { numRuns: 100 },
    );
    expect(completed).toBeGreaterThan(5);
    expect(crashedRuns).toBeGreaterThan(50);
  }, 60_000);

  it("finishes a lead through a crash at each step of the happy path", async () => {
    // Deliveries are doubled because a sender retries a webhook that wasn't acknowledged.
    const happyPath: readonly SimAction[] = [
      { tag: "deliver", index: 0 },
      { tag: "deliver", index: 0 },
      { tag: "dispatch" },
      { tag: "advance", ms: HOUR },
      { tag: "dispatch" },
      { tag: "send", limit: 4 },
      { tag: "send", limit: 4 },
      { tag: "deliver", index: 4 },
      { tag: "deliver", index: 4 },
      { tag: "dispatch" },
      { tag: "send", limit: 4 },
    ];
    // Skipping writes lets a crash land inside a step, not just on its first write.
    for (let position = 0; position <= happyPath.length; position += 1) {
      for (const timing of ["before", "after"] as const) {
        for (const skip of [0, 1, 2, 3, 4]) {
          const actions = [
            ...happyPath.slice(0, position),
            { tag: "crash", timing, skip } as const,
            ...happyPath.slice(position),
          ];
          const simulation = await runSchedule(actions);
          const links = simulation.harness.gateway.sent.filter((message) =>
            message.action.text.includes("https://"),
          );
          expect.soft(links.length, `crash ${timing} step ${position} skip ${skip}`).toBeGreaterThan(0);
        }
      }
    }
  });
});
