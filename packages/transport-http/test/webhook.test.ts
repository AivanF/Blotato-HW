import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { platformId, type EventInbox, type InboundEvent } from "@automations/core";
import { commentEvent, createMemoryStore } from "@automations/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { createWebhookHandler, reply, type WebhookCodec } from "../src/index.ts";

const platform = platformId("test");

/** Accepts `{"events": [...]}` signed with the header "secret". */
const codec: WebhookCodec = {
  platform,
  verify: (_raw, headers) => headers["x-signature"] === "secret",
  decode: (body) =>
    typeof body === "object" && body !== null && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: InboundEvent[] }).events)
      : null,
  challenge: (query) => (query.get("token") === "ok" ? query.get("challenge") : null),
};

let server: Server | undefined;

const start = async (inbox: Pick<EventInbox, "appendEvents">, maxBodyBytes = 1_000) => {
  const handle = createWebhookHandler({ codecs: [codec], inbox, maxBodyBytes });
  server = createServer((request, response) => {
    void handle(request, response).then((handled) => {
      if (!handled) reply(response, 404, "Not found.");
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
});

const event = commentEvent("e1", "alice", 0);

const post = (base: string, body: string, path = "/webhooks/test", signature = "secret") =>
  fetch(`${base}${path}`, { method: "POST", headers: { "x-signature": signature }, body });

describe("the webhook handler", () => {
  it("stores events, then acknowledges", async () => {
    const store = createMemoryStore();
    const base = await start(store);
    const response = await post(base, JSON.stringify({ events: [event] }));
    expect(response.status).toBe(200);
    expect((await store.claimEvent(0, 10))?.eventId).toBe("e1");
  });

  it("acknowledges a redelivered webhook without storing it twice", async () => {
    const store = createMemoryStore();
    const base = await start(store);
    await post(base, JSON.stringify({ events: [event] }));
    expect((await post(base, JSON.stringify({ events: [event] }))).status).toBe(200);
    await store.claimEvent(0, 10);
    await store.completeEvent(event);
    expect(await store.claimEvent(0, 10)).toBeNull();
  });

  it("rejects a bad signature without storing anything", async () => {
    const store = createMemoryStore();
    const base = await start(store);
    const response = await post(base, JSON.stringify({ events: [event] }), "/webhooks/test", "nope");
    expect(response.status).toBe(401);
    expect(await store.claimEvent(0, 10)).toBeNull();
  });

  it("rejects malformed JSON and payloads the codec can't decode", async () => {
    const base = await start(createMemoryStore());
    expect((await post(base, "{not json")).status).toBe(400);
    expect((await post(base, JSON.stringify({ wrong: true }))).status).toBe(400);
  });

  it("rejects events claiming to be from another platform", async () => {
    const store = createMemoryStore();
    const base = await start(store);
    const forged = { ...event, platform: "other" };
    expect((await post(base, JSON.stringify({ events: [forged] }))).status).toBe(400);
    expect(await store.claimEvent(0, 10)).toBeNull();
  });

  it("rejects an oversized body", async () => {
    const base = await start(createMemoryStore(), 100);
    expect((await post(base, "x".repeat(101))).status).toBe(413);
  });

  it("asks the platform to retry when events can't be stored", async () => {
    const base = await start({
      appendEvents: async () => {
        throw new Error("database down");
      },
    });
    expect((await post(base, JSON.stringify({ events: [event] }))).status).toBe(503);
  });

  it("answers 404 for an unknown platform, and leaves other paths alone", async () => {
    const base = await start(createMemoryStore());
    expect((await post(base, "{}", "/webhooks/elsewhere")).status).toBe(404);
    expect((await post(base, "{}", "/other")).status).toBe(404);
  });

  it("answers a subscription handshake only with the right token", async () => {
    const base = await start(createMemoryStore());
    const good = await fetch(`${base}/webhooks/test?token=ok&challenge=abc`);
    expect([good.status, await good.text()]).toEqual([200, "abc"]);
    expect((await fetch(`${base}/webhooks/test?token=bad&challenge=abc`)).status).toBe(403);
  });

  it("refuses other methods", async () => {
    const base = await start(createMemoryStore());
    expect((await fetch(`${base}/webhooks/test`, { method: "PUT", body: "{}" })).status).toBe(405);
  });
});
