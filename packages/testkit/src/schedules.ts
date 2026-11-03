import fc from "fast-check";
import { MINUTE } from "./harness.ts";
import { createSimulation, SCENARIO_SIZE, type SimAction, type SimulationParts } from "./simulator.ts";

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

/** Without this, few schedules reach the end of the flow: replies mostly arrive too early. */
const contacts: fc.Arbitrary<SimAction> = fc
  .nat(100)
  .map((index): SimAction => ({ tag: "answer", index }));

const faults: fc.Arbitrary<SimAction> = fc.oneof(
  fc
    .tuple(fc.constantFrom("before" as const, "after" as const), fc.nat(4))
    .map(([timing, skip]): SimAction => ({ tag: "crash", timing, skip })),
  fc.constantFrom("transient" as const, "permanent" as const, "ambiguous" as const).map(
    (script): SimAction => ({ tag: "gatewayFault", script }),
  ),
);

const schedule = (...parts: readonly fc.Arbitrary<SimAction>[]) =>
  // `size: "max"` because fast-check otherwise favours short arrays, too short to finish a flow.
  fc.array(fc.oneof(...parts), { minLength: 10, maxLength: 80, size: "max" });

export const arbHealthySchedule = schedule(engineWork, world, contacts);
export const arbFaultySchedule = schedule(engineWork, world, contacts, faults);

/** Runs a schedule on any store, checking safety after each action and everything at the end. */
export const runSchedule = async (actions: readonly SimAction[], parts: SimulationParts = {}) => {
  const simulation = createSimulation(parts);
  for (const action of actions) {
    await simulation.perform(action);
    await simulation.checkSafety();
  }
  await simulation.drain();
  await simulation.checkFinal();
  return simulation;
};
