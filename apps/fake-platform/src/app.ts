import type { IncomingMessage, ServerResponse } from "node:http";
import type { Action } from "@automations/core";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  sign,
  type FakeSendRequest,
  type FakeWebhook,
  type FakeWebhookEvent,
} from "@automations/platform-fake";
import { readBody, reply } from "@automations/transport-http";

const DAY = 24 * 3_600_000;

export type SentMessage = {
  readonly key: string;
  readonly account: string;
  readonly action: Action;
  readonly at: number;
};

export type FakePlatformConfig = {
  /** Where to deliver webhooks, such as "http://server:8080". */
  readonly serverUrl: string;
  readonly secret: string;
  readonly now?: () => number;
};

/**
 * Plays the social platform: simulates users commenting and messaging, delivers signed
 * webhooks, and receives the replies and DMs we send. It enforces the same rules as the real
 * platform, so a policy violation shows up as a failed send instead of passing silently.
 */
export const createFakePlatform = (config: FakePlatformConfig) => {
  const now = config.now ?? Date.now;
  const sent: SentMessage[] = [];
  const keys = new Set<string>();
  const comments = new Map<string, { account: string; from: string }>();
  const privatelyReplied = new Set<string>();
  const lastMessageAt = new Map<string, number>();
  const failures: { status: number; retryAfterSeconds?: number }[] = [];
  let counter = 0;

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  const deliver = async (account: string, event: FakeWebhookEvent): Promise<number> => {
    const body = JSON.stringify({ account, events: [event] } satisfies FakeWebhook);
    const response = await fetch(`${config.serverUrl}/webhooks/fake`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(config.secret, body) },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    return response.status;
  };

  /** Applies the platform's messaging rules. Returns an error, or null if the send is allowed. */
  const refuse = (request: FakeSendRequest): string | null => {
    const { account, action } = request;
    if (action.kind === "replyToComment") {
      return comments.has(action.commentId) ? null : "Unknown comment.";
    }
    if (action.recipient.kind === "viaComment") {
      const { commentId } = action.recipient;
      if (!comments.has(commentId)) return "Unknown comment.";
      if (privatelyReplied.has(commentId)) return "This comment already has a private reply.";
      return null;
    }
    const last = lastMessageAt.get(JSON.stringify([account, action.recipient.contactId]));
    return last !== undefined && now() - last <= DAY ? null : "Outside the messaging window.";
  };

  const send = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const key = request.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== "string" || key === "") {
      return json(response, 400, { error: "An idempotency key is required." });
    }
    const body = JSON.parse((await readBody(request, 100_000)).toString()) as FakeSendRequest;
    if (keys.has(key)) {
      return json(response, 200, { duplicate: true });
    }
    const failure = failures.shift();
    if (failure !== undefined) {
      response.writeHead(failure.status, {
        ...(failure.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(failure.retryAfterSeconds) }),
      });
      response.end("Injected failure.");
      return;
    }
    const refusal = refuse(body);
    if (refusal !== null) {
      return json(response, 400, { error: refusal });
    }
    if (body.action.kind === "sendDm" && body.action.recipient.kind === "viaComment") {
      privatelyReplied.add(body.action.recipient.commentId);
    }
    keys.add(key);
    sent.push({ key, account: body.account, action: body.action, at: now() });
    json(response, 200, { ok: true });
  };

  const simulate = async (
    request: IncomingMessage,
    response: ServerResponse,
    type: "comment" | "message",
  ): Promise<void> => {
    const input = JSON.parse((await readBody(request, 100_000)).toString()) as {
      account: string;
      from: string;
      text: string;
      fromName?: string;
      postId?: string;
      /** Reuse an id to replay a webhook, the way a platform retries. */
      id?: string;
    };
    counter += 1;
    const id = input.id ?? `evt-${counter}`;
    const timestamp = now();
    let event: FakeWebhookEvent;
    if (type === "comment") {
      const commentId = `cmt-${id}`;
      comments.set(commentId, { account: input.account, from: input.from });
      event = {
        type,
        id,
        commentId,
        postId: input.postId ?? "post-1",
        from: input.from,
        text: input.text,
        timestamp,
        ...(input.fromName === undefined ? {} : { fromName: input.fromName }),
      };
    } else {
      lastMessageAt.set(JSON.stringify([input.account, input.from]), timestamp);
      event = { type, id, from: input.from, text: input.text, timestamp };
    }
    try {
      const status = await deliver(input.account, event);
      json(response, status === 200 ? 200 : 502, { eventId: id, serverStatus: status });
    } catch (error) {
      json(response, 502, { eventId: id, error: String(error) });
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method} ${pathname}`;
    try {
      switch (route) {
        case "GET /healthz":
          return reply(response, 200, "OK");
        case "GET /sent":
          return json(response, 200, sent);
        case "POST /send":
          return await send(request, response);
        case "POST /simulate/comment":
          return await simulate(request, response, "comment");
        case "POST /simulate/message":
          return await simulate(request, response, "message");
        case "POST /fail-next": {
          failures.push(JSON.parse((await readBody(request, 10_000)).toString()));
          return json(response, 200, { queued: failures.length });
        }
        default:
          return reply(response, 404, "Not found.");
      }
    } catch (error) {
      json(response, 400, { error: String(error) });
    }
  };

  return { handle, sent };
};
