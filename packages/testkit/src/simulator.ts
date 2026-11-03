import { isDeepStrictEqual } from "node:util";
import {
  actionClass,
  initialState,
  replay,
  runIdFor,
  type InboundEvent,
  type Input,
  type MachineConfig,
  type PlatformPolicy,
  type RateLimiter,
  type RunStore,
  type Instant,
} from "@automations/core";
import {
  commentEvent,
  createHarness,
  DAY,
  HOUR,
  LINK,
  messageEvent,
  mustValidate,
  pricingDefinition,
  SELF_ID,
  testAccount,
  type GatewayScript,
  type Harness,
} from "./harness.ts";
import { createMemoryStore } from "./memoryStore.ts";

/** Stands in for the process dying. Anything else escaping the engine is a real bug. */
export class SimulatedCrash extends Error {}

export type CrashTiming = "before" | "after";

export type CrashingStore = {
  readonly store: RunStore;
  /** After `skip` more writes, the next one dies, either before it commits or just after. */
  arm(timing: CrashTiming, skip: number): void;
  disarm(): void;
  crashes(): number;
};

const WRITES: ReadonlySet<PropertyKey> = new Set<keyof RunStore>([
  "appendEvents",
  "claimEvent",
  "completeEvent",
  "startRun",
  "applyInput",
  "claimEffects",
  "retryEffect",
  "deferEffect",
  "finishEffect",
]);

export const withCrashes = (inner: RunStore): CrashingStore => {
  let armed: { timing: CrashTiming; skip: number } | null = null;
  let count = 0;
  /** Decides at the start of a write, so concurrent writes can't both take the same crash. */
  const takeCrash = (): CrashTiming | null => {
    if (armed === null) {
      return null;
    }
    if (armed.skip > 0) {
      armed.skip -= 1;
      return null;
    }
    const { timing } = armed;
    armed = null;
    count += 1;
    return timing;
  };
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !WRITES.has(property)) {
        return value;
      }
      return async (...args: unknown[]) => {
        const crash = takeCrash();
        if (crash === "before") {
          throw new SimulatedCrash("Crash before a write.");
        }
        const result: unknown = await value.apply(target, args);
        if (crash === "after") {
          throw new SimulatedCrash("Crash after a write.");
        }
        return result;
      };
    },
  });
  return {
    store,
    arm: (timing, skip) => {
      armed = { timing, skip };
    },
    disarm: () => {
      armed = null;
    },
    crashes: () => count,
  };
};

/** One thing that can happen next. A schedule is any list of these. */
export type SimAction =
  | { readonly tag: "deliver"; readonly index: number }
  /** A contact replies, but only once they've actually been DMed, as a real person would. */
  | { readonly tag: "answer"; readonly index: number }
  | { readonly tag: "dispatch" }
  | { readonly tag: "send"; readonly limit: number }
  | { readonly tag: "timers" }
  | { readonly tag: "advance"; readonly ms: number }
  | { readonly tag: "crash"; readonly timing: CrashTiming; readonly skip: number }
  | { readonly tag: "gatewayFault"; readonly script: GatewayScript }
  | { readonly tag: "parallel" };

/** Each webhook the outside world could send, with its time fixed on first delivery. */
type Webhook = (occurredAt: Instant) => InboundEvent;

const scenario: readonly Webhook[] = [
  (at) => commentEvent("a-comment", "alice", at),
  (at) => commentEvent("a-comment-again", "alice", at),
  (at) => messageEvent("a-invalid", "alice", at, "what's the price?"),
  (at) => messageEvent("a-invalid-2", "alice", at, "tell me"),
  (at) => messageEvent("a-email", "alice", at, "sure, alice@example.com"),
  (at) => commentEvent("b-comment", "bob", at),
  (at) => messageEvent("b-email", "bob", at, "bob@example.com"),
  (at) => commentEvent("c-comment", "carol", at),
  (at) => commentEvent("self-comment", SELF_ID, at),
  (at) => commentEvent("off-topic", "dave", at, "nice photo"),
];

export const SCENARIO_SIZE = scenario.length;

const replyIndices = scenario.flatMap((webhook, index) =>
  webhook(0).kind === "message" ? [index] : [],
);

export const simPolicy: PlatformPolicy = {
  dmFromComment: { maxMessages: 1, withinMs: 7 * DAY },
  followUpWindowMs: DAY,
  rateLimits: [
    { action: "privateReply", max: 2, perMs: 60_000 },
    { action: "directMessage", max: 2, perMs: 60_000 },
  ],
};

const engineOptions = {
  eventLeaseMs: 30_000,
  effectLeaseMs: 30_000,
  maxFailures: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

const DRAIN_STEPS = 100;

const fail = (message: string): never => {
  throw new Error(`Invariant broken: ${message}`);
};

export type Simulation = {
  readonly harness: Harness;
  perform(action: SimAction): Promise<void>;
  /** Stops faults, then runs until everything that can finish has finished. */
  drain(): Promise<void>;
  checkSafety(): Promise<void>;
  checkFinal(): Promise<void>;
  /** True if nothing went wrong along the way, so each message should go out exactly once. */
  wasFaultFree(): boolean;
};

/** Defaults to the in-memory parts. Pass real ones to run the same schedules on them. */
export type SimulationParts = {
  readonly store?: RunStore;
  readonly limiter?: RateLimiter;
};

export const createSimulation = (parts: SimulationParts = {}): Simulation => {
  const crashing = withCrashes(parts.store ?? createMemoryStore());
  const harness = createHarness({
    store: crashing.store,
    ...(parts.limiter === undefined ? {} : { limiter: parts.limiter }),
    policy: simPolicy,
    automations: [{ versionId: "pricing-v1", definition: pricingDefinition }],
    engine: engineOptions,
  });
  const { clock, engine, gateway, store } = harness;
  const config: MachineConfig = {
    definition: mustValidate(pricingDefinition, simPolicy),
    policy: simPolicy,
  };

  const delivered = new Map<number, InboundEvent>();
  let gatewayFaults = 0;

  const surviving = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) {
        throw error;
      }
    }
  };

  const deliver = async (index: number): Promise<void> => {
    const webhook = scenario[index] as Webhook;
    const event = delivered.get(index) ?? webhook(clock.now());
    delivered.set(index, event);
    await store.appendEvents([event]);
  };

  const commentEvents = (): readonly InboundEvent[] =>
    [...delivered.values()].filter((event) => event.kind === "comment");

  const hasBeenDmed = (contact: string): boolean => {
    const theirComments = new Set(
      commentEvents().flatMap((event) =>
        event.kind === "comment" && event.authorId === contact ? [event.commentId] : [],
      ),
    );
    return gateway.sent.some(
      ({ action }) =>
        action.kind === "sendDm" &&
        action.recipient.kind === "viaComment" &&
        theirComments.has(action.recipient.commentId),
    );
  };

  const emailReply = (eventId: string) => {
    const index = scenario.findIndex((webhook) => webhook(0).eventId === eventId);
    return { ...(scenario[index] as Webhook)(0), index };
  };

  const answer = async (choice: number): Promise<void> => {
    const index = replyIndices[choice % replyIndices.length] as number;
    const reply = (scenario[index] as Webhook)(0);
    if (reply.kind === "message" && hasBeenDmed(reply.senderId)) {
      await deliver(index);
    }
  };

  const perform = async (action: SimAction): Promise<void> => {
    switch (action.tag) {
      case "deliver":
        return surviving(() => deliver(action.index));
      case "answer":
        return surviving(() => answer(action.index));
      case "dispatch":
        return surviving(() => engine.dispatchNext());
      case "send":
        return surviving(() => engine.sendEffects(action.limit));
      case "timers":
        return surviving(() => engine.fireTimers(10));
      case "advance":
        clock.advance(action.ms);
        return;
      case "crash":
        crashing.arm(action.timing, action.skip);
        return;
      case "gatewayFault":
        gatewayFaults += 1;
        gateway.failNext(action.script);
        return;
      case "parallel":
        await Promise.all([
          surviving(() => engine.dispatchNext()),
          surviving(() => engine.dispatchNext()),
          surviving(() => engine.sendEffects(2)),
          surviving(() => engine.sendEffects(2)),
          surviving(() => engine.fireTimers(10)),
        ]);
        return;
    }
  };

  const drain = async (): Promise<void> => {
    crashing.disarm();
    // Senders keep retrying until acknowledged, so everything sent ends up stored.
    await store.appendEvents([...delivered.values()]);
    for (let index = 0; index < DRAIN_STEPS; index += 1) {
      await surviving(async () => {
        // Whoever has a valid email to give answers once asked. Carol never does, so runs expire too.
        for (const event of [emailReply("a-email"), emailReply("b-email")]) {
          if (event.kind === "message" && hasBeenDmed(event.senderId) && !delivered.has(event.index)) {
            await deliver(event.index);
          }
        }
        while (await engine.dispatchNext());
        while ((await engine.sendEffects(5)) > 0);
        await engine.fireTimers(10);
      });
      clock.advance(HOUR);
    }
  };

  const checkSafety = async (): Promise<void> => {
    // Never more than one active run per contact.
    const active = new Map<string, number>();
    for (const event of commentEvents()) {
      const run = await store.getRun(runIdFor(event));
      if (run !== null && run.state.tag !== "done") {
        const count = (active.get(run.ref.contactId) ?? 0) + 1;
        active.set(run.ref.contactId, count);
        if (count > 1) fail(`${run.ref.contactId} has ${count} active runs.`);
      }
    }

    // Never over a rate limit, in any window.
    for (const limit of simPolicy.rateLimits) {
      const times = gateway.sent
        .filter((message) => actionClass(message.action) === limit.action)
        .map((message) => message.at);
      for (const at of times) {
        const inWindow = times.filter((other) => other > at - limit.perMs && other <= at);
        if (inWindow.length > limit.max) {
          fail(`${inWindow.length} ${limit.action} sends in one window.`);
        }
      }
    }

    // Always within the platform's messaging rules.
    const events = [...delivered.values()];
    const distinctPrivateReplies = new Map<string, Set<string>>();
    for (const message of gateway.sent) {
      if (message.action.kind !== "sendDm") continue;
      const { recipient } = message.action;
      if (recipient.kind === "viaComment") {
        const keys = distinctPrivateReplies.get(recipient.commentId) ?? new Set();
        keys.add(message.key);
        distinctPrivateReplies.set(recipient.commentId, keys);
        if (keys.size > 1) fail(`More than one private reply to ${recipient.commentId}.`);
        const comment = events.find(
          (event) => event.kind === "comment" && event.commentId === recipient.commentId,
        );
        if (comment === undefined || message.at > comment.occurredAt + 7 * DAY) {
          fail(`Private reply outside its window: ${message.key}.`);
        }
      } else {
        const inWindow = events.some(
          (event) =>
            event.kind === "message" &&
            event.senderId === recipient.contactId &&
            event.occurredAt <= message.at &&
            message.at <= event.occurredAt + DAY,
        );
        if (!inWindow) fail(`DM with no reply in the last day: ${message.key}.`);
      }
    }
  };

  const checkFinal = async (): Promise<void> => {
    await checkSafety();
    if ((await store.claimEvent(clock.now(), 1)) !== null) {
      fail("An event was left unprocessed.");
    }

    const knownKeys = new Set<string>();
    for (const event of commentEvents()) {
      const runId = runIdFor(event);
      const run = await store.getRun(runId);

      // Every event must lead somewhere: a run, a recorded suppression, or a reason to ignore it.
      const ignorable =
        event.kind === "comment" && (event.authorId === SELF_ID || !event.text.includes("pricing"));
      if (ignorable && run !== null) fail(`${event.eventId} shouldn't have started a run.`);
      const suppressed = harness.notes.some(
        (note) => note.tag === "runSuppressed" && note.event.eventId === event.eventId,
      );
      if (!ignorable && run === null && !suppressed) {
        fail(`${event.eventId} was lost: no run and no suppression.`);
      }
      if (run === null) continue;

      if (run.state.tag !== "done") fail(`Run for ${event.eventId} never finished.`);

      // The persisted system must agree with the pure fold.
      const log = await store.transitions(runId);
      const inputs: readonly Input[] = log.map((entry) => entry.input);
      const replayed = replay(config, inputs, initialState);
      const records = await store.effects(runId);
      if (!isDeepStrictEqual(replayed.state, run.state)) {
        fail(`Run for ${event.eventId} disagrees with the fold of its log.`);
      }
      if (
        !isDeepStrictEqual(
          replayed.effects,
          records.map((row) => row.effect),
        )
      ) {
        fail(`Outbox for ${event.eventId} disagrees with the fold of its log.`);
      }

      const firstSends: number[] = [];
      for (const record of records) {
        const key = `${runId}:${record.effect.seq}`;
        knownKeys.add(key);
        const sends = gateway.sent.filter((message) => message.key === key);
        if (record.status === "queued") fail(`Effect ${key} is still queued.`);
        if (record.status === "delivered" && sends.length === 0) {
          fail(`Effect ${key} is marked delivered but never sent.`);
        }
        if (gateway.faulted.size === 0 && crashing.crashes() === 0 && sends.length > 1) {
          fail(`Effect ${key} was sent ${sends.length} times with no fault.`);
        }
        const first = sends[0];
        if (first !== undefined) {
          firstSends.push(gateway.sent.indexOf(first));
        }

        // A captured lead must get the link, unless a fault was injected on that very send.
        const isLink =
          record.effect.action.kind === "sendDm" && record.effect.action.text.includes(LINK);
        if (isLink && record.status !== "delivered" && !gateway.faulted.has(key)) {
          fail(`Lead ${event.eventId} lost the link: ${record.status}, ${record.lastError}.`);
        }
      }
      if (firstSends.some((position, index) => position < (firstSends[index - 1] ?? -1))) {
        fail(`Effects for ${event.eventId} were sent out of order.`);
      }

      const captured = log.some((entry) => entry.contact?.email !== undefined);
      const contact = await store.getContact(testAccount, run.ref.contactId);
      if (captured && contact?.email === null) {
        fail(`${run.ref.contactId} gave an email that wasn't saved.`);
      }
    }

    for (const message of gateway.sent) {
      if (!knownKeys.has(message.key)) fail(`Sent a message no run asked for: ${message.key}.`);
    }
  };

  return {
    harness,
    perform,
    drain,
    checkSafety,
    checkFinal,
    wasFaultFree: () => gatewayFaults === 0 && crashing.crashes() === 0,
  };
};
