import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Action } from "@automations/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeCodec,
  createFakeGateway,
  FAKE_PLATFORM,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  sign,
  type FakeWebhook,
} from "../src/index.ts";

const codec = createFakeCodec("secret");

const webhook: FakeWebhook = {
  account: "acme",
  events: [
    {
      type: "comment",
      id: "e1",
      commentId: "c1",
      postId: "p1",
      from: "alice",
      fromName: "Alice",
      text: "Pricing?",
      timestamp: 5,
    },
    { type: "message", id: "e2", from: "alice", text: "a@b.co", timestamp: 6 },
  ],
};

describe("the fake codec", () => {
  it("verifies its own signature over the raw bytes", () => {
    const raw = Buffer.from(JSON.stringify(webhook));
    expect(codec.verify(raw, { [SIGNATURE_HEADER]: sign("secret", raw) })).toBe(true);
  });

  it("rejects a missing, wrong or tampered signature", () => {
    const raw = Buffer.from(JSON.stringify(webhook));
    expect(codec.verify(raw, {})).toBe(false);
    expect(codec.verify(raw, { [SIGNATURE_HEADER]: sign("other", raw) })).toBe(false);
    expect(codec.verify(Buffer.from(`${raw} `), { [SIGNATURE_HEADER]: sign("secret", raw) })).toBe(false);
  });

  it("decodes comments and messages into canonical events", () => {
    expect(codec.decode(webhook)).toEqual([
      {
        platform: FAKE_PLATFORM,
        accountId: "acme",
        eventId: "e1",
        kind: "comment",
        commentId: "c1",
        postId: "p1",
        authorId: "alice",
        authorName: "Alice",
        text: "Pricing?",
        occurredAt: 5,
      },
      {
        platform: FAKE_PLATFORM,
        accountId: "acme",
        eventId: "e2",
        kind: "message",
        senderId: "alice",
        text: "a@b.co",
        occurredAt: 6,
      },
    ]);
  });

  it("rejects a payload with any malformed event", () => {
    expect(codec.decode({ account: "acme", events: [{ type: "comment", id: "e1" }] })).toBeNull();
    expect(codec.decode({ account: "acme", events: [{ ...webhook.events[1], type: "story" }] })).toBeNull();
    expect(codec.decode({ events: [] })).toBeNull();
    expect(codec.decode("nope")).toBeNull();
  });
});

describe("the fake gateway", () => {
  let server: Server | undefined;
  const requests: { key: string | undefined; body: unknown }[] = [];

  const respondWith = async (status: number, headers: Record<string, string> = {}) => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push({ key: request.headers[IDEMPOTENCY_HEADER] as string, body: JSON.parse(body) });
        response.writeHead(status, headers).end("details");
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    return createFakeGateway({ baseUrl: `http://localhost:${(server.address() as AddressInfo).port}` });
  };

  afterEach(async () => {
    requests.length = 0;
    await new Promise((resolve) => (server === undefined ? resolve(undefined) : server.close(resolve)));
    server = undefined;
  });

  const account = { platform: FAKE_PLATFORM, accountId: "acme" };
  const action: Action = { kind: "replyToComment", commentId: "c1", text: "Hi" };

  it("sends the action with its idempotency key", async () => {
    const gateway = await respondWith(200);
    expect(await gateway.perform(account, action, "run:0")).toEqual({ tag: "ok" });
    expect(requests).toEqual([{ key: "run:0", body: { account: "acme", action } }]);
  });

  it("treats 429 and 5xx as retryable, honouring Retry-After", async () => {
    const gateway = await respondWith(429, { "retry-after": "30" });
    expect(await gateway.perform(account, action, "k")).toEqual({
      tag: "transient",
      error: "HTTP 429: details",
      retryAfterMs: 30_000,
    });
  });

  it("treats a 5xx without Retry-After as retryable", async () => {
    const gateway = await respondWith(503);
    expect(await gateway.perform(account, action, "k")).toEqual({
      tag: "transient",
      error: "HTTP 503: details",
    });
  });

  it("treats other client errors as permanent", async () => {
    const gateway = await respondWith(400);
    expect(await gateway.perform(account, action, "k")).toEqual({
      tag: "permanent",
      error: "HTTP 400: details",
    });
  });

  it("throws when the platform can't be reached, since the send may or may not have happened", async () => {
    const gateway = createFakeGateway({ baseUrl: "http://localhost:1", timeoutMs: 1_000 });
    await expect(gateway.perform(account, action, "k")).rejects.toThrow();
  });
});
