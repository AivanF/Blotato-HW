import { setTimeout as sleep } from "node:timers/promises";
import type { Engine } from "@automations/core";

export type WorkerOptions = {
  readonly dispatchers: number;
  readonly senders: number;
  /** How long an idle or failing loop waits before trying again. */
  readonly pollMs: number;
  readonly batch: number;
  readonly signal: AbortSignal;
  readonly onError: (error: unknown) => void;
};

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  sleep(ms, undefined, { signal }).catch(() => undefined);

/** Repeats one engine step. An error is logged, then treated like an idle step. */
const loop = async (work: () => Promise<boolean>, options: WorkerOptions): Promise<void> => {
  while (!options.signal.aborted) {
    let busy = false;
    try {
      busy = await work();
    } catch (error) {
      options.onError(error);
    }
    if (!busy) {
      await pause(options.pollMs, options.signal);
    }
  }
};

const times = <T>(count: number, make: () => T): T[] => Array.from({ length: count }, make);

/**
 * Runs the engine until `signal` aborts, then resolves once every loop has finished its
 * current step. A step interrupted by a crash instead is recovered by leases.
 */
export const runWorkers = async (engine: Engine, options: WorkerOptions): Promise<void> => {
  await Promise.all([
    ...times(options.dispatchers, () => loop(() => engine.dispatchNext(), options)),
    ...times(options.senders, () =>
      loop(async () => (await engine.sendEffects(options.batch)) > 0, options),
    ),
    loop(async () => (await engine.fireTimers(options.batch)) > 0, options),
  ]);
};
