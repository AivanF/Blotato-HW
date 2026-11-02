import { transitionFor, type EngineDeps } from "./context.ts";

/** Fires up to `limit` due timers, and returns how many were due. */
export const fireTimers = async (deps: EngineDeps, limit: number): Promise<number> => {
  const now = deps.clock.now();
  const due = await deps.store.dueRuns(now, limit);
  for (const { run, wakeAt } of due) {
    await deps.store.applyInput(
      run.runId,
      { tag: "TimerFired", id: `timer:${wakeAt}`, at: now },
      await transitionFor(deps, run),
    );
  }
  return due.length;
};
