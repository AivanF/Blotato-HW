import type { IncomingMessage, ServerResponse } from "node:http";
import { createEngine, type EngineDeps, type EngineOptions } from "@automations/core";
import { createWebhookHandler, reply, type WebhookCodec } from "@automations/transport-http";
import { runWorkers } from "./workers.ts";

export type Log = (level: "info" | "warn" | "error", message: string, fields?: object) => void;

export const jsonLog: Log = (level, message, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));
};

export type ServerAppDeps = EngineDeps & {
  readonly codecs: readonly WebhookCodec[];
  readonly engineOptions: EngineOptions;
  readonly health: () => Promise<unknown>;
  readonly log: Log;
};

export type ServerApp = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  run(options: { signal: AbortSignal; dispatchers: number; senders: number; pollMs: number }): Promise<void>;
};

const describe = (error: unknown): object =>
  error instanceof Error ? { error: error.message, stack: error.stack } : { error: String(error) };

/** Wires the engine to HTTP. Everything it touches comes in through `deps`. */
export const createServerApp = (deps: ServerAppDeps): ServerApp => {
  const engine = createEngine(deps, deps.engineOptions);
  const webhooks = createWebhookHandler({
    codecs: deps.codecs,
    inbox: deps.store,
    onError: (error) => deps.log("error", "Couldn't store a webhook.", describe(error)),
  });

  return {
    async handle(request, response) {
      try {
        if (await webhooks(request, response)) {
          return;
        }
        const { pathname } = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && pathname === "/healthz") {
          await deps.health();
          return reply(response, 200, "OK");
        }
        reply(response, 404, "Not found.");
      } catch (error) {
        deps.log("error", "Request failed.", describe(error));
        if (!response.headersSent) reply(response, 500, "Internal error.");
      }
    },

    run: ({ signal, dispatchers, senders, pollMs }) =>
      runWorkers(engine, {
        dispatchers,
        senders,
        pollMs,
        batch: 10,
        signal,
        onError: (error) => deps.log("error", "Engine step failed.", describe(error)),
      }),
  };
};
