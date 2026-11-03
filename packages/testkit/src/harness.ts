import {
  createEngine,
  defaultEngineOptions,
  platformId,
  validate,
  type AccountRef,
  type Action,
  type AutomationCatalog,
  type Clock,
  type Definition,
  type Engine,
  type EngineNote,
  type EngineOptions,
  type InboundEvent,
  type Instant,
  type Outcome,
  type PlatformGateway,
  type PlatformPolicy,
  type RateLimiter,
  type RunStore,
  type ValidDefinition,
} from "@automations/core";
import { createMemoryStore } from "./memoryStore.ts";
import { createMemoryRateLimiter } from "./rateLimiter.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const testPlatform = platformId("test");
export const testAccount: AccountRef = { platform: testPlatform, accountId: "account-1" };
export const SELF_ID = "self";

/** Modelled on Instagram's rules, with limits tight enough to matter in short tests. */
export const testPolicy: PlatformPolicy = {
  dmFromComment: { maxMessages: 1, withinMs: 7 * DAY },
  followUpWindowMs: DAY,
  rateLimits: [],
};

export const LINK = "https://example.com/pricing";

/** The example from the task. */
export const pricingDefinition: Definition = {
  trigger: { kind: "comment", keyword: "pricing", posts: "any" },
  entry: "reply",
  nodes: {
    reply: { kind: "replyToComment", text: "Sent you a DM!", onFailure: "continue", next: "ask" },
    ask: { kind: "sendDm", text: "What's your email?", onFailure: "abort", next: "wait" },
    wait: {
      kind: "awaitReply",
      extract: { kind: "email" },
      bindAs: "email",
      onMatch: "link",
      reprompt: "That doesn't look like an email. Could you resend it?",
      maxReprompts: 1,
      onExhausted: "gaveUp",
      timeoutMs: 72 * HOUR,
      onTimeout: "expired",
    },
    link: { kind: "sendDm", text: `Thanks {{email}}! ${LINK}`, onFailure: "abort", next: "done" },
    done: { kind: "end", outcome: "completed" },
    gaveUp: { kind: "end", outcome: "abandoned" },
    expired: { kind: "end", outcome: "expired" },
  },
};

export const mustValidate = (definition: Definition, policy = testPolicy): ValidDefinition => {
  const result = validate(definition, [{ platform: testPlatform, policy }]);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  return result.definition;
};

export type FakeClock = Clock & { advance(ms: number): void };

export const createFakeClock = (start: Instant = 1_000_000): FakeClock => {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
};

export type SentMessage = { readonly key: string; readonly action: Action; readonly at: Instant };

/** "ambiguous" delivers the message but reports a failure, like a timeout on the response. */
export type GatewayScript = "transient" | "permanent" | "ambiguous";

export type FakeGateway = PlatformGateway & {
  /** Messages that actually reached a contact, including duplicates. */
  readonly sent: SentMessage[];
  /** Keys that got a scripted failure. */
  readonly faulted: Set<string>;
  failNext(script: GatewayScript, retryAfterMs?: number): void;
};

export const createFakeGateway = (clock: Clock): FakeGateway => {
  const script: { kind: GatewayScript; retryAfterMs?: number }[] = [];
  const sent: SentMessage[] = [];
  const faulted = new Set<string>();
  return {
    sent,
    faulted,
    failNext(kind, retryAfterMs) {
      script.push(retryAfterMs === undefined ? { kind } : { kind, retryAfterMs });
    },
    async perform(_account, action, key): Promise<Outcome> {
      const next = script.shift();
      if (next !== undefined) {
        faulted.add(key);
      }
      if (next === undefined || next.kind === "ambiguous") {
        sent.push({ key, action, at: clock.now() });
      }
      if (next === undefined) {
        return { tag: "ok" };
      }
      if (next.kind === "permanent") {
        return { tag: "permanent", error: "rejected" };
      }
      return next.retryAfterMs === undefined
        ? { tag: "transient", error: "unavailable" }
        : { tag: "transient", error: "unavailable", retryAfterMs: next.retryAfterMs };
    },
  };
};

export type CatalogAutomation = {
  readonly versionId: string;
  readonly definition: Definition;
};

/** `automations` are in priority order, highest first. */
export const createStaticCatalog = (
  automations: readonly CatalogAutomation[],
  policy: PlatformPolicy = testPolicy,
): AutomationCatalog => {
  const validated = new Map(
    automations.map(({ versionId, definition }) => [versionId, mustValidate(definition, policy)]),
  );
  return {
    forAccount: async () => ({
      selfAuthorId: SELF_ID,
      automations: automations.map(({ versionId, definition }) => ({
        versionId,
        trigger: definition.trigger,
      })),
    }),
    definition: async (versionId) => validated.get(versionId) ?? null,
  };
};

export type HarnessOptions = {
  readonly store?: RunStore;
  readonly limiter?: RateLimiter;
  readonly policy?: PlatformPolicy;
  readonly automations?: readonly CatalogAutomation[];
  readonly engine?: EngineOptions;
};

export type Harness = {
  readonly clock: FakeClock;
  readonly store: RunStore;
  readonly gateway: FakeGateway;
  readonly limiter: RateLimiter;
  readonly notes: EngineNote[];
  readonly engine: Engine;
};

/** The whole engine wired to in-memory parts. */
export const createHarness = (options: HarnessOptions = {}): Harness => {
  const clock = createFakeClock();
  const store = options.store ?? createMemoryStore();
  const gateway = createFakeGateway(clock);
  const limiter = options.limiter ?? createMemoryRateLimiter();
  const notes: EngineNote[] = [];
  const policy = options.policy ?? testPolicy;
  const automations = options.automations ?? [
    { versionId: "pricing-v1", definition: pricingDefinition },
  ];
  const engine = createEngine(
    {
      store,
      catalog: createStaticCatalog(automations, policy),
      platforms: new Map([[testPlatform, { policy, gateway }]]),
      limiter,
      clock,
      notes: (note) => notes.push(note),
    },
    options.engine ?? defaultEngineOptions,
  );
  return { clock, store, gateway, limiter, notes, engine };
};

export const commentEvent = (
  eventId: string,
  contact: string,
  occurredAt: Instant,
  text = "pricing please",
): InboundEvent => ({
  platform: testAccount.platform,
  accountId: testAccount.accountId,
  eventId,
  kind: "comment",
  commentId: `comment-${eventId}`,
  postId: "post-1",
  authorId: contact,
  text,
  occurredAt,
});

export const messageEvent = (
  eventId: string,
  contact: string,
  occurredAt: Instant,
  text: string,
): InboundEvent => ({
  platform: testAccount.platform,
  accountId: testAccount.accountId,
  eventId,
  kind: "message",
  senderId: contact,
  text,
  occurredAt,
});
