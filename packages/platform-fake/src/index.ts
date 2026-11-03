import { createHmac, timingSafeEqual } from "node:crypto";
import {
  platformId,
  type Action,
  type InboundEvent,
  type Outcome,
  type PlatformGateway,
  type PlatformPolicy,
} from "@automations/core";
import type { WebhookCodec } from "@automations/transport-http";

/**
 * A stand-in for a real social platform, shaped like Instagram's messaging API: signed
 * webhooks, private replies addressed by comment, idempotency keys, and errors as statuses.
 */
export const FAKE_PLATFORM = platformId("fake");

const HOUR = 3_600_000;

/** Instagram's messaging rules. The rate limits are illustrative, not Meta's published ones. */
export const fakePolicy: PlatformPolicy = {
  dmFromComment: { maxMessages: 1, withinMs: 7 * 24 * HOUR },
  followUpWindowMs: 24 * HOUR,
  rateLimits: [
    { action: "privateReply", max: 750, perMs: HOUR },
    { action: "directMessage", max: 750, perMs: HOUR },
    { action: "commentReply", max: 750, perMs: HOUR },
  ],
};

export type FakeWebhookEvent =
  | {
      readonly type: "comment";
      readonly id: string;
      readonly commentId: string;
      readonly postId: string;
      readonly from: string;
      readonly fromName?: string;
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      readonly type: "message";
      readonly id: string;
      readonly from: string;
      readonly text: string;
      readonly timestamp: number;
    };

export type FakeWebhook = {
  readonly account: string;
  readonly events: readonly FakeWebhookEvent[];
};

export type FakeSendRequest = {
  readonly account: string;
  readonly action: Action;
};

export const SIGNATURE_HEADER = "x-fake-signature-256";
export const IDEMPOTENCY_HEADER = "idempotency-key";

export const sign = (secret: string, body: string | Buffer): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const isText = (value: unknown): value is string => typeof value === "string";

const decodeEvent = (account: string, raw: unknown): InboundEvent | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as Record<string, unknown>;
  const { id, from, text, timestamp } = event;
  if (!isText(id) || !isText(from) || !isText(text) || typeof timestamp !== "number") return null;
  const base = { platform: FAKE_PLATFORM, accountId: account, eventId: id, text, occurredAt: timestamp };
  if (event["type"] === "message") {
    return { ...base, kind: "message", senderId: from };
  }
  const { commentId, postId, fromName } = event;
  if (event["type"] !== "comment" || !isText(commentId) || !isText(postId)) return null;
  if (fromName !== undefined && !isText(fromName)) return null;
  return {
    ...base,
    kind: "comment",
    commentId,
    postId,
    authorId: from,
    ...(fromName === undefined ? {} : { authorName: fromName }),
  };
};

export const createFakeCodec = (secret: string): WebhookCodec => ({
  platform: FAKE_PLATFORM,
  verify(rawBody, headers) {
    const given = Buffer.from(String(headers[SIGNATURE_HEADER] ?? ""));
    const expected = Buffer.from(sign(secret, rawBody));
    return given.length === expected.length && timingSafeEqual(given, expected);
  },
  decode(body) {
    if (typeof body !== "object" || body === null) return null;
    const { account, events } = body as Record<string, unknown>;
    if (!isText(account) || !Array.isArray(events)) return null;
    const decoded = events.map((event) => decodeEvent(account, event));
    return decoded.every((event) => event !== null) ? (decoded as InboundEvent[]) : null;
  },
});

export type FakeGatewayOptions = {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
};

const retryAfterMs = (header: string | null): number | undefined => {
  const seconds = Number(header);
  return header !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
};

/**
 * Maps HTTP onto `Outcome`: 429 and 5xx can be retried, other errors can't. A network error
 * or timeout throws, because we can't tell whether the message went out.
 */
export const createFakeGateway = (options: FakeGatewayOptions): PlatformGateway => ({
  async perform(account, action, idempotencyKey): Promise<Outcome> {
    const request: FakeSendRequest = { account: account.accountId, action };
    const response = await fetch(`${options.baseUrl}/send`, {
      method: "POST",
      headers: { "content-type": "application/json", [IDEMPOTENCY_HEADER]: idempotencyKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (response.ok) {
      return { tag: "ok" };
    }
    const error = `HTTP ${response.status}: ${await response.text()}`;
    if (response.status === 429 || response.status >= 500) {
      const wait = retryAfterMs(response.headers.get("retry-after"));
      return wait === undefined ? { tag: "transient", error } : { tag: "transient", error, retryAfterMs: wait };
    }
    return { tag: "permanent", error };
  },
});
