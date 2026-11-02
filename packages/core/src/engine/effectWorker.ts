import { actionClass } from "../machine.ts";
import type { ClaimedEffect, EffectResult, Outcome, PlatformGateway } from "../ports.ts";
import { platformOf, transitionFor, type EngineDeps, type EngineOptions } from "./context.ts";

/** A thrown error means we can't tell whether the send happened, so it's treated as retryable. */
const performSafely = async (
  gateway: PlatformGateway,
  { run, effect }: ClaimedEffect,
): Promise<Outcome> => {
  try {
    return await gateway.perform(run.account, effect.action, `${run.runId}:${effect.seq}`);
  } catch (error) {
    return { tag: "transient", error: String(error) };
  }
};

const finish = async (
  deps: EngineDeps,
  { run, effect }: ClaimedEffect,
  result: EffectResult,
): Promise<void> => {
  await deps.store.finishEffect(
    { runId: run.runId, seq: effect.seq },
    result,
    {
      tag: "EffectSettled",
      id: `settled:${effect.seq}`,
      at: deps.clock.now(),
      seq: effect.seq,
      ok: result.tag === "delivered",
    },
    await transitionFor(deps, run),
  );
  if (result.tag === "failed") {
    deps.notes({ tag: "effectFailed", run, seq: effect.seq, error: result.error });
  }
};

const backoffMs = (options: EngineOptions, failures: number, retryAfterMs = 0): number =>
  Math.max(retryAfterMs, Math.min(options.backoffBaseMs * 2 ** failures, options.backoffMaxMs));

const handle = async (
  deps: EngineDeps,
  options: EngineOptions,
  claim: ClaimedEffect,
): Promise<void> => {
  const { run, effect, attempt, failures } = claim;
  const ref = { runId: run.runId, seq: effect.seq };
  const now = deps.clock.now();
  const { policy, gateway } = platformOf(deps, run.account);

  if (effect.notAfter !== null && now > effect.notAfter) {
    await finish(deps, claim, { tag: "failed", error: "The platform's send window has passed." });
    return;
  }

  const action = actionClass(effect.action);
  for (const limit of policy.rateLimits.filter((rule) => rule.action === action)) {
    const decision = await deps.limiter.acquire(run.account, limit, now);
    if (decision.tag === "denied") {
      await deps.store.deferEffect(ref, attempt, decision.retryAt);
      return;
    }
  }

  const outcome = await performSafely(gateway, claim);
  switch (outcome.tag) {
    case "ok":
      await finish(deps, claim, { tag: "delivered" });
      return;
    case "permanent":
      await finish(deps, claim, { tag: "failed", error: outcome.error });
      return;
    case "transient":
      if (failures + 1 >= options.maxFailures) {
        await finish(deps, claim, { tag: "failed", error: outcome.error });
      } else {
        const delay = backoffMs(options, failures, outcome.retryAfterMs);
        await deps.store.retryEffect(ref, attempt, deps.clock.now() + delay, outcome.error);
      }
  }
};

/**
 * Sends up to `limit` effects at once, and returns how many it claimed. Each one finishes or
 * fails independently, so one bad send can't abandon the others mid-flight.
 */
export const sendEffects = async (
  deps: EngineDeps,
  options: EngineOptions,
  limit: number,
): Promise<number> => {
  const claims = await deps.store.claimEffects(deps.clock.now(), limit, options.effectLeaseMs);
  const results = await Promise.allSettled(claims.map((claim) => handle(deps, options, claim)));
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  return claims.length;
};
