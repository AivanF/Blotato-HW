import {
  eventContact,
  initialState,
  wakeAt,
  type AccountRef,
  type ClaimedEffect,
  type Effect,
  type EffectStatus,
  type EventRef,
  type InboundEvent,
  type Input,
  type Instant,
  type RunRef,
  type RunState,
  type RunStore,
  type TransitionFn,
  type TransitionRecord,
} from "@automations/core";

type EventRow = {
  readonly event: InboundEvent;
  processed: boolean;
  leaseUntil: Instant | null;
};

type RunRow = {
  readonly ref: RunRef;
  state: RunState;
  readonly log: TransitionRecord[];
  readonly applied: Set<string>;
};

type EffectRow = {
  readonly run: RunRef;
  readonly effect: Effect;
  status: EffectStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Instant;
  leaseUntil: Instant | null;
};

/** The same round trip a JSON column makes, so nothing here depends on shared references. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const eventKey = (ref: EventRef): string =>
  JSON.stringify([ref.platform, ref.accountId, ref.eventId]);

const contactKey = (event: InboundEvent): string =>
  JSON.stringify([event.platform, event.accountId, eventContact(event)]);

const accountKey = (account: AccountRef): string =>
  JSON.stringify([account.platform, account.accountId]);

const isActive = (row: RunRow): boolean => row.state.tag !== "done";

const isFree = (leaseUntil: Instant | null, now: Instant): boolean =>
  leaseUntil === null || leaseUntil <= now;

/**
 * Enforces the same constraints a real database would, or tests would pass on behaviour
 * production rejects. Single-threaded with no `await` inside a method, so every method is
 * atomic. That also means it can't reveal real races: those need the Postgres contract run.
 */
export const createMemoryStore = (): RunStore => {
  const events = new Map<string, EventRow>();
  const runs = new Map<string, RunRow>();
  const effects: EffectRow[] = [];

  const findEffect = (runId: string, seq: number): EffectRow | undefined =>
    effects.find((row) => row.run.runId === runId && row.effect.seq === seq);

  /** `f` runs before any write, so if it throws nothing has changed. */
  const apply = (row: RunRow, input: Input, f: TransitionFn): "applied" | "duplicate" => {
    if (row.applied.has(input.id)) {
      return "duplicate";
    }
    const transition = copy(f(copy(row.state), copy(input)));
    row.state = transition.state;
    row.applied.add(input.id);
    row.log.push({ input: copy(input), effects: transition.effects, state: transition.state });
    for (const effect of transition.effects) {
      effects.push({
        run: row.ref,
        effect,
        status: "queued",
        attempts: 0,
        lastError: null,
        nextAttemptAt: Number.NEGATIVE_INFINITY,
        leaseUntil: null,
      });
    }
    if (row.state.tag === "done" && row.state.outcome === "failed") {
      for (const queued of effects) {
        if (queued.run.runId === row.ref.runId && queued.status === "queued") {
          queued.status = "cancelled";
        }
      }
    }
    return "applied";
  };

  return {
    async appendEvents(batch) {
      for (const event of batch) {
        const key = eventKey(event);
        if (!events.has(key)) {
          events.set(key, { event: copy(event), processed: false, leaseUntil: null });
        }
      }
    },

    async claimEvent(now, leaseMs) {
      const seenContacts = new Set<string>();
      for (const row of events.values()) {
        const contact = contactKey(row.event);
        if (!row.processed && !seenContacts.has(contact)) {
          seenContacts.add(contact);
          if (isFree(row.leaseUntil, now)) {
            row.leaseUntil = now + leaseMs;
            return copy(row.event);
          }
        }
      }
      return null;
    },

    async completeEvent(ref) {
      const row = events.get(eventKey(ref));
      if (row !== undefined) {
        row.processed = true;
      }
    },

    async startRun(run, input, f) {
      if (runs.has(run.runId)) {
        return "duplicate";
      }
      const account = accountKey(run.account);
      const occupied = [...runs.values()].some(
        (row) =>
          isActive(row) &&
          row.ref.contactId === run.contactId &&
          accountKey(row.ref.account) === account,
      );
      if (occupied) {
        return "suppressed";
      }
      const row: RunRow = { ref: copy(run), state: initialState, log: [], applied: new Set() };
      apply(row, input, f);
      runs.set(run.runId, row);
      return "started";
    },

    async applyInput(runId, input, f) {
      const row = runs.get(runId);
      return row === undefined ? "unknownRun" : apply(row, input, f);
    },

    async findActiveRun(account, contactId) {
      const key = accountKey(account);
      for (const row of runs.values()) {
        if (isActive(row) && row.ref.contactId === contactId && accountKey(row.ref.account) === key) {
          return copy(row.ref);
        }
      }
      return null;
    },

    async dueRuns(now, limit) {
      return [...runs.values()]
        .flatMap((row) => {
          const due = wakeAt(row.state);
          return due !== null && due <= now ? [{ run: copy(row.ref), wakeAt: due }] : [];
        })
        .sort((a, b) => a.wakeAt - b.wakeAt)
        .slice(0, limit);
    },

    async getRun(runId) {
      const row = runs.get(runId);
      return row === undefined ? null : copy({ ref: row.ref, state: row.state });
    },

    async transitions(runId) {
      return copy(runs.get(runId)?.log ?? []);
    },

    async claimEffects(now, limit, leaseMs) {
      const seenRuns = new Set<string>();
      const readyByAccount = new Map<string, EffectRow[]>();
      for (const row of effects) {
        if (row.status === "queued" && !seenRuns.has(row.run.runId)) {
          seenRuns.add(row.run.runId);
          if (row.nextAttemptAt <= now && isFree(row.leaseUntil, now)) {
            const key = accountKey(row.run.account);
            readyByAccount.set(key, [...(readyByAccount.get(key) ?? []), row]);
          }
        }
      }

      const claimed: ClaimedEffect[] = [];
      for (let turn = 0; claimed.length < limit; turn += 1) {
        const round = [...readyByAccount.values()].flatMap((rows) => rows.slice(turn, turn + 1));
        if (round.length === 0) {
          break;
        }
        for (const row of round.slice(0, limit - claimed.length)) {
          row.attempts += 1;
          row.leaseUntil = now + leaseMs;
          claimed.push(copy({ run: row.run, effect: row.effect, attempt: row.attempts }));
        }
      }
      return claimed;
    },

    async retryEffect(ref, attempt, retryAt, error) {
      const row = findEffect(ref.runId, ref.seq);
      if (row !== undefined && row.status === "queued" && row.attempts === attempt) {
        row.nextAttemptAt = retryAt;
        row.leaseUntil = null;
        row.lastError = error;
      }
    },

    async finishEffect(ref, result, input, f) {
      const run = runs.get(ref.runId);
      const row = findEffect(ref.runId, ref.seq);
      if (run === undefined || row === undefined) {
        return;
      }
      apply(run, input, f);
      if (row.status === "queued" || row.status === "cancelled") {
        row.status = result.tag;
        row.leaseUntil = null;
        row.lastError = result.tag === "failed" ? result.error : row.lastError;
      }
    },

    async effects(runId) {
      return copy(
        effects
          .filter((row) => row.run.runId === runId)
          .map(({ effect, status, attempts, lastError }) => ({
            effect,
            status,
            attempts,
            lastError,
          })),
      );
    },
  };
};
