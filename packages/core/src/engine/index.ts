import { defaultEngineOptions, type EngineDeps, type EngineOptions } from "./context.ts";
import { dispatchNext } from "./dispatcher.ts";
import { sendEffects } from "./effectWorker.ts";
import { fireTimers } from "./timerSweeper.ts";

export { defaultEngineOptions, type EngineDeps, type EngineOptions } from "./context.ts";
export { runIdFor } from "./dispatcher.ts";

/** Single steps with no loops or timers inside, so a server or a simulator can schedule them. */
export type Engine = {
  dispatchNext(): Promise<boolean>;
  sendEffects(limit: number): Promise<number>;
  fireTimers(limit: number): Promise<number>;
};

export const createEngine = (
  deps: EngineDeps,
  options: EngineOptions = defaultEngineOptions,
): Engine => ({
  dispatchNext: () => dispatchNext(deps, options),
  sendEffects: (limit) => sendEffects(deps, options, limit),
  fireTimers: (limit) => fireTimers(deps, limit),
});
