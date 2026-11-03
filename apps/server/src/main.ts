import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { defaultEngineOptions } from "@automations/core";
import {
  createFakeCodec,
  createFakeGateway,
  FAKE_PLATFORM,
  fakePolicy,
} from "@automations/platform-fake";
import {
  createPool,
  createPostgresRateLimiter,
  createPostgresStore,
  migrate,
} from "@automations/store-postgres";
import { createServerApp, jsonLog } from "./app.ts";
import { loadCatalog } from "./catalog.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set.`);
  return value;
};
const number = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

const pool = createPool({ connectionString: required("DATABASE_URL") });
await migrate(pool);

const catalog = loadCatalog(
  JSON.parse(await readFile(process.env["AUTOMATIONS_FILE"] ?? "apps/server/automations.json", "utf8")),
  new Map([[FAKE_PLATFORM, fakePolicy]]),
);

const app = createServerApp({
  store: createPostgresStore(pool),
  limiter: createPostgresRateLimiter(pool),
  catalog,
  platforms: new Map([
    [FAKE_PLATFORM, { policy: fakePolicy, gateway: createFakeGateway({ baseUrl: required("FAKE_PLATFORM_URL") }) }],
  ]),
  clock: { now: Date.now },
  notes: (note) => jsonLog("warn", note.tag, note),
  codecs: [createFakeCodec(required("WEBHOOK_SECRET"))],
  engineOptions: defaultEngineOptions,
  health: () => pool.query("SELECT 1"),
  log: jsonLog,
});

const port = number("PORT", 8080);
const server = createServer((request, response) => void app.handle(request, response));
server.listen(port, () => jsonLog("info", "Server listening.", { port }));

const stop = new AbortController();
const workers = app.run({
  signal: stop.signal,
  dispatchers: number("DISPATCHERS", 2),
  senders: number("SENDERS", 2),
  pollMs: number("POLL_MS", 200),
});

/** Stops taking webhooks, lets each worker finish its step, then closes the database. */
const shutdown = async (signal: string): Promise<void> => {
  jsonLog("info", "Shutting down.", { signal });
  server.close();
  stop.abort();
  await workers;
  await pool.end();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
