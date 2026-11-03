import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbFaultySchedule, arbHealthySchedule, HOUR, runSchedule, type SimAction } from "../src/index.ts";

describe("the system under an adversarial schedule", () => {
  it("keeps every guarantee through crashes, faults, duplicates and reordering", async () => {
    await fc.assert(
      fc.asyncProperty(arbFaultySchedule, async (actions) => {
        await runSchedule(actions);
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it("sends each message exactly once when nothing goes wrong", async () => {
    await fc.assert(
      fc.asyncProperty(arbHealthySchedule, async (actions) => {
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
      fc.asyncProperty(arbFaultySchedule, async (actions) => {
        const simulation = await runSchedule(actions);
        const { sent } = simulation.harness.gateway;
        if (sent.some((message) => message.action.text.includes("https://"))) completed += 1;
        if (!simulation.wasFaultFree()) crashedRuns += 1;
      }),
      // A fixed seed, because this measures the generator and shouldn't vary between runs.
      { numRuns: 100, seed: 42 },
    );
    expect(completed).toBeGreaterThan(40);
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
