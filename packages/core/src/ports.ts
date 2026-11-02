import type { Trigger, ValidDefinition } from "./definition.ts";
import type { EventRef, InboundEvent, Instant } from "./events.ts";
import type { Action, Effect, Input, RunState, Transition } from "./machine.ts";
import type { PlatformId, PlatformPolicy, RateLimit } from "./platform.ts";

export type AccountRef = {
  readonly platform: PlatformId;
  readonly accountId: string;
};

export type RunRef = {
  /** Derive it from the trigger event, so retrying that event can't create a second run. */
  readonly runId: string;
  readonly versionId: string;
  readonly account: AccountRef;
  readonly contactId: string;
};

export type EffectRef = { readonly runId: string; readonly seq: number };

/** Must be pure: an adapter may call it again when it retries after a conflict. */
export type TransitionFn = (state: RunState, input: Input) => Transition;

/**
 * A durable inbox. Events from one contact are handed out one at a time, oldest first, so
 * "hmm" and "a@b.co" reach a run in the order they arrived.
 */
export interface EventInbox {
  /** Resolves only once the events are durable. Events already seen are dropped silently. */
  appendEvents(events: readonly InboundEvent[]): Promise<void>;
  /** The lease stops other workers taking this contact's events until it expires. */
  claimEvent(now: Instant, leaseMs: number): Promise<InboundEvent | null>;
  completeEvent(ref: EventRef): Promise<void>;
}

export type RunRecord = {
  readonly ref: RunRef;
  readonly state: RunState;
};

export type TransitionRecord = Transition & { readonly input: Input };

export type DueRun = {
  readonly run: RunRef;
  /** Makes a stable input id for the timer, so firing it twice counts once. */
  readonly wakeAt: Instant;
};

/**
 * Runs and their history. Each write commits the state, its log entry and its effects
 * together, or nothing at all if `f` throws.
 *
 * At most one unfinished run may exist per account and contact, which gives every DM reply
 * exactly one addressee. A run that fails has its queued effects cancelled in the same write.
 */
export interface RunLog {
  /** Checks for a duplicate first, then for suppression. Calls `f` only if neither applies. */
  startRun(
    run: RunRef,
    input: Input,
    f: TransitionFn,
  ): Promise<"started" | "duplicate" | "suppressed">;
  /** Applies each input id at most once per run. */
  applyInput(
    runId: string,
    input: Input,
    f: TransitionFn,
  ): Promise<"applied" | "duplicate" | "unknownRun">;
  findActiveRun(account: AccountRef, contactId: string): Promise<RunRef | null>;
  /** Unfinished runs whose timer is due, oldest first. */
  dueRuns(now: Instant, limit: number): Promise<readonly DueRun[]>;
  getRun(runId: string): Promise<RunRecord | null>;
  transitions(runId: string): Promise<readonly TransitionRecord[]>;
}

export type EffectStatus = "queued" | "delivered" | "failed" | "cancelled";

export type ClaimedEffect = {
  readonly run: RunRef;
  readonly effect: Effect;
  /** Identifies this claim. A release from an older claim is ignored. */
  readonly attempt: number;
  /** Failed sends so far. Differs from `attempt` because rate-limit waits aren't failures. */
  readonly failures: number;
};

export type EffectRecord = {
  readonly effect: Effect;
  readonly status: EffectStatus;
  readonly attempts: number;
  readonly failures: number;
  readonly lastError: string | null;
};

export type EffectResult =
  | { readonly tag: "delivered" }
  | { readonly tag: "failed"; readonly error: string };

/** A transactional outbox. */
export interface EffectOutbox {
  /**
   * Hands out only the earliest unfinished effect of each run, so a run has at most one
   * effect in flight and its messages keep their order. Accounts share `limit` in turns, so
   * one busy account can't starve the rest.
   */
  claimEffects(now: Instant, limit: number, leaseMs: number): Promise<readonly ClaimedEffect[]>;
  /** Counts a failed send and releases the effect until `retryAt`, if `attempt` is the latest claim. */
  retryEffect(ref: EffectRef, attempt: number, retryAt: Instant, error: string): Promise<void>;
  /** Releases the effect until `retryAt` without counting a failure, if `attempt` is the latest claim. */
  deferEffect(ref: EffectRef, attempt: number, retryAt: Instant): Promise<void>;
  /**
   * Records the result and applies `input` to the run in one write. If they were separate, a
   * crash between them would leave the run waiting on an effect it can never hear about.
   *
   * The first result wins, except over "cancelled": what really happened to a message that
   * was already in flight outranks the cancellation.
   */
  finishEffect(ref: EffectRef, result: EffectResult, input: Input, f: TransitionFn): Promise<void>;
  effects(runId: string): Promise<readonly EffectRecord[]>;
}

export type Contact = {
  /** Holds the social platform and the customer's account on it. */
  readonly account: AccountRef;
  /** The contact's user ID on that platform. */
  readonly contactId: string;
  readonly nickname: string | null;
  readonly email: string | null;
};

/**
 * Contacts are written only as part of a run's transition: each `contact` patch is merged
 * into the stored contact, creating it if needed, in the same write as the run's state.
 */
export interface ContactBook {
  getContact(account: AccountRef, contactId: string): Promise<Contact | null>;
}

/** Atomicity spans all of these, so one adapter implements them together. */
export type RunStore = EventInbox & RunLog & EffectOutbox & ContactBook;

export type Outcome =
  | { readonly tag: "ok" }
  | { readonly tag: "transient"; readonly error: string; readonly retryAfterMs?: number }
  | { readonly tag: "permanent"; readonly error: string };

/** Each platform adapter also maps its own error responses onto `Outcome`. */
export interface PlatformGateway {
  perform(account: AccountRef, action: Action, idempotencyKey: string): Promise<Outcome>;
}

export type Platform = {
  readonly policy: PlatformPolicy;
  readonly gateway: PlatformGateway;
};

export type Platforms = ReadonlyMap<PlatformId, Platform>;

export type RateDecision =
  | { readonly tag: "granted" }
  | { readonly tag: "denied"; readonly retryAt: Instant };

/** Shared between workers, so limits hold however many are running. */
export interface RateLimiter {
  /** Grants at most `limit.max` per account in any window of `limit.perMs`. */
  acquire(account: AccountRef, limit: RateLimit, now: Instant): Promise<RateDecision>;
}

export interface Clock {
  now(): Instant;
}

export type CatalogEntry = {
  readonly versionId: string;
  readonly trigger: Trigger;
};

export type AccountAutomations = {
  /** The account's own user ID, so its comments can be ignored. */
  readonly selfAuthorId: string;
  /** Active automations targeting this account, highest priority first. */
  readonly automations: readonly CatalogEntry[];
};

export interface AutomationCatalog {
  forAccount(account: AccountRef): Promise<AccountAutomations>;
  definition(versionId: string): Promise<ValidDefinition | null>;
}

export type EngineNote =
  | { readonly tag: "runSuppressed"; readonly event: InboundEvent; readonly versionId: string }
  | {
      readonly tag: "effectFailed";
      readonly run: RunRef;
      readonly seq: number;
      readonly error: string;
    };

/** For logs and alerts. Best-effort, because durable truth lives in the store. */
export type NoteSink = (note: EngineNote) => void;
