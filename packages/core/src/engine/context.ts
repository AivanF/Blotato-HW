import { step } from "../machine.ts";
import type {
  AccountRef,
  AutomationCatalog,
  Clock,
  NoteSink,
  Platform,
  Platforms,
  RateLimiter,
  RunStore,
  TransitionFn,
} from "../ports.ts";

export type EngineDeps = {
  readonly store: RunStore;
  readonly catalog: AutomationCatalog;
  readonly platforms: Platforms;
  readonly limiter: RateLimiter;
  readonly clock: Clock;
  readonly notes: NoteSink;
};

export type EngineOptions = {
  /** How long a worker holds an event before another may take it over. */
  readonly eventLeaseMs: number;
  /** Must comfortably exceed the gateway's timeout, or a slow send can be duplicated. */
  readonly effectLeaseMs: number;
  /** Failed sends before an effect is given up on. */
  readonly maxFailures: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
};

export const defaultEngineOptions: EngineOptions = {
  eventLeaseMs: 30_000,
  effectLeaseMs: 60_000,
  maxFailures: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 300_000,
};

export const platformOf = (deps: EngineDeps, account: AccountRef): Platform => {
  const platform = deps.platforms.get(account.platform);
  if (platform === undefined) {
    throw new Error(`No platform registered for "${account.platform}".`);
  }
  return platform;
};

/** Loads what `step` needs up front, so the store receives a pure, synchronous function. */
export const transitionFor = async (
  deps: EngineDeps,
  run: { readonly versionId: string; readonly account: AccountRef },
): Promise<TransitionFn> => {
  const definition = await deps.catalog.definition(run.versionId);
  if (definition === null) {
    throw new Error(`Automation version "${run.versionId}" does not exist.`);
  }
  const { policy } = platformOf(deps, run.account);
  return (state, input) => step({ definition, policy }, state, input);
};
