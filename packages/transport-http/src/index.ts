import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { EventInbox, InboundEvent, PlatformId } from "@automations/core";

/** How one platform's webhooks look over HTTP. Signature checks need the raw bytes. */
export interface WebhookCodec {
  readonly platform: PlatformId;
  verify(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  /** Null means the payload is malformed. */
  decode(body: unknown): readonly InboundEvent[] | null;
  /** Answers a subscription handshake, such as Meta's `hub.challenge`. Null refuses it. */
  challenge?(query: URLSearchParams): string | null;
}

export class BodyTooLarge extends Error {}

/** Keeps reading past the limit and discards it, so the client gets a clean 413. */
export const readBody = (request: IncomingMessage, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    request.on("end", () =>
      size > maxBytes ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks)),
    );
    request.on("error", reject);
  });

export const reply = (response: ServerResponse, status: number, text: string): void => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
};

export type WebhookHandlerOptions = {
  readonly codecs: readonly WebhookCodec[];
  readonly inbox: Pick<EventInbox, "appendEvents">;
  readonly maxBodyBytes?: number;
  readonly onError?: (error: unknown) => void;
};

/**
 * Serves `/webhooks/<platform>`, and returns false for any other path. It acknowledges only
 * once events are durable, so a failure makes the platform retry instead of losing them.
 */
export const createWebhookHandler = (options: WebhookHandlerOptions) => {
  const codecs = new Map<string, WebhookCodec>(options.codecs.map((codec) => [codec.platform, codec]));
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (match === null) {
      return false;
    }
    const codec = codecs.get(decodeURIComponent(match[1] as string));
    if (codec === undefined) {
      reply(response, 404, "Unknown platform.");
      return true;
    }

    if (request.method === "GET") {
      const answer = codec.challenge?.(url.searchParams) ?? null;
      reply(response, answer === null ? 403 : 200, answer ?? "Refused.");
      return true;
    }
    if (request.method !== "POST") {
      reply(response, 405, "Use POST.");
      return true;
    }

    let raw: Buffer;
    try {
      raw = await readBody(request, maxBodyBytes);
    } catch (error) {
      reply(response, error instanceof BodyTooLarge ? 413 : 400, "Unreadable body.");
      return true;
    }
    if (!codec.verify(raw, request.headers)) {
      reply(response, 401, "Bad signature.");
      return true;
    }

    let events: readonly InboundEvent[] | null;
    try {
      events = codec.decode(JSON.parse(raw.toString("utf8")));
    } catch {
      events = null;
    }
    // A codec bug must not let one platform's webhook inject another platform's events.
    if (events === null || events.some((event) => event.platform !== codec.platform)) {
      reply(response, 400, "Malformed payload.");
      return true;
    }

    try {
      await options.inbox.appendEvents(events);
    } catch (error) {
      options.onError?.(error);
      reply(response, 503, "Not stored. Retry later.");
      return true;
    }
    reply(response, 200, "OK");
    return true;
  };
};
