import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defaultEngineOptions, type EngineNote } from "@automations/core";
import { createFakePlatform } from "@automations/fake-platform";
import {
  createFakeCodec,
  createFakeGateway,
  FAKE_PLATFORM,
  fakePolicy,
  SIGNATURE_HEADER,
} from "@automations/platform-fake";
import { createMemoryRateLimiter, createMemoryStore } from "@automations/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../src/app.ts";
import { loadCatalog } from "../src/catalog.ts";

const SECRET = "test-secret";

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
};

const waitFor = async (what: string, check: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The real server and fake platform in one process, over real HTTP, with an in-memory store. */
describe("the server and platform together", () => {
  let serverHttp: Server;
  let platformHttp: Server;
  let platformUrl: string;
  let serverUrl: string;
  let platform: ReturnType<typeof createFakePlatform>;
  let store: ReturnType<typeof createMemoryStore>;
  let notes: EngineNote[];
  let stop: AbortController;
  let workers: Promise<void>;

  beforeEach(async () => {
    serverHttp = createServer();
    platformHttp = createServer();
    serverUrl = await listen(serverHttp);
    platformUrl = await listen(platformHttp);

    store = createMemoryStore();
    notes = [];
    platform = createFakePlatform({ serverUrl, secret: SECRET });
    const app = createServerApp({
      store,
      limiter: createMemoryRateLimiter(),
      catalog: loadCatalog(
        JSON.parse(await readFile(new URL("../automations.json", import.meta.url), "utf8")),
        new Map([[FAKE_PLATFORM, fakePolicy]]),
      ),
      platforms: new Map([[FAKE_PLATFORM, { policy: fakePolicy, gateway: createFakeGateway({ baseUrl: platformUrl }) }]]),
      clock: { now: Date.now },
      notes: (note) => notes.push(note),
      codecs: [createFakeCodec(SECRET)],
      engineOptions: defaultEngineOptions,
      health: async () => undefined,
      log: () => undefined,
    });
    serverHttp.on("request", (request, response) => void app.handle(request, response));
    platformHttp.on("request", (request, response) => void platform.handle(request, response));
    stop = new AbortController();
    workers = app.run({ signal: stop.signal, dispatchers: 2, senders: 2, pollMs: 5 });
  });

  afterEach(async () => {
    stop.abort();
    await workers;
    serverHttp.closeAllConnections();
    platformHttp.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => serverHttp.close(resolve)),
      new Promise((resolve) => platformHttp.close(resolve)),
    ]);
  });

  const simulate = async (type: "comment" | "message", body: object) => {
    const response = await fetch(`${platformUrl}/simulate/${type}`, {
      method: "POST",
      body: JSON.stringify({ account: "acme", ...body }),
    });
    return response.status;
  };

  const texts = () => platform.sent.map((message) => message.action.text);

  it("runs the pricing flow end to end, and saves the contact", async () => {
    expect(await simulate("comment", { from: "alice", fromName: "Alice", text: "Pricing?" })).toBe(200);
    await waitFor("the ask", () => texts().length === 2);
    expect(texts()).toEqual(["Sent you a DM!", "Hi! What's your email address?"]);

    expect(await simulate("message", { from: "alice", text: "sure: alice@example.com" })).toBe(200);
    await waitFor("the link", () => texts().length === 3);
    expect(texts()[2]).toContain("alice@example.com");
    expect(texts()[2]).toContain("https://example.com/pricing");
    expect(await store.getContact({ platform: FAKE_PLATFORM, accountId: "acme" }, "alice")).toMatchObject({
      nickname: "Alice",
      email: "alice@example.com",
    });
  });

  it("ignores off-topic comments and the account's own", async () => {
    await simulate("comment", { from: "bob", text: "Nice photo" });
    await simulate("comment", { from: "acme", text: "Ask us about pricing!" });
    await simulate("comment", { id: "evt-carol", from: "carol", text: "pricing" });
    await waitFor("carol's ask", () => texts().length === 2);
    // Idempotency keys contain the trigger event's id, so this shows who each message was for.
    expect(platform.sent.every((message) => message.key.includes("evt-carol"))).toBe(true);
  });

  it("handles a webhook the platform delivers twice", async () => {
    await simulate("comment", { id: "evt-dup", from: "alice", text: "pricing" });
    await simulate("comment", { id: "evt-dup", from: "alice", text: "pricing" });
    await waitFor("the ask", () => texts().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(texts()).toHaveLength(2);
    expect(notes).toEqual([]);
  });

  it("retries a send the platform rejects for a moment", async () => {
    await fetch(`${platformUrl}/fail-next`, { method: "POST", body: JSON.stringify({ status: 503 }) });
    await simulate("comment", { from: "alice", text: "pricing" });
    await waitFor("both messages, after a retry", () => texts().length === 2);
  });

  it("refuses an unsigned webhook", async () => {
    const response = await fetch(`${serverUrl}/webhooks/fake`, {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: "sha256=00" },
      body: JSON.stringify({ account: "acme", events: [] }),
    });
    expect(response.status).toBe(401);
  });

  it("reports healthy", async () => {
    expect((await fetch(`${serverUrl}/healthz`)).status).toBe(200);
  });
});
