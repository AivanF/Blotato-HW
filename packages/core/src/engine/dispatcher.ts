import type { Comment, InboundEvent, Message } from "../events.ts";
import type { AccountRef } from "../ports.ts";
import { selectAutomation } from "../trigger.ts";
import { transitionFor, type EngineDeps, type EngineOptions } from "./context.ts";

type CommentEvent = Extract<InboundEvent, { kind: "comment" }>;
type MessageEvent = Extract<InboundEvent, { kind: "message" }>;

/** The same event always gives the same id, so processing it twice can't start two runs. */
export const runIdFor = (event: InboundEvent): string =>
  JSON.stringify([event.platform, event.accountId, event.eventId]);

const accountOf = (event: InboundEvent): AccountRef => ({
  platform: event.platform,
  accountId: event.accountId,
});

const commentOf = ({ platform, accountId, eventId, kind, ...comment }: CommentEvent): Comment =>
  comment;

const onComment = async (deps: EngineDeps, event: CommentEvent): Promise<void> => {
  const account = accountOf(event);
  const { selfAuthorId, automations } = await deps.catalog.forAccount(account);
  const chosen = selectAutomation(automations, event, selfAuthorId);
  if (chosen === null) {
    return;
  }
  const run = {
    runId: runIdFor(event),
    versionId: chosen.versionId,
    account,
    contactId: event.authorId,
  };
  const result = await deps.store.startRun(
    run,
    { tag: "Started", id: `event:${event.eventId}`, at: event.occurredAt, comment: commentOf(event) },
    await transitionFor(deps, run),
  );
  if (result === "suppressed") {
    deps.notes({ tag: "runSuppressed", event, versionId: chosen.versionId });
  }
};

const onMessage = async (deps: EngineDeps, event: MessageEvent): Promise<void> => {
  const message: Message = event;
  const run = await deps.store.findActiveRun(accountOf(event), message.senderId);
  if (run !== null) {
    await deps.store.applyInput(
      run.runId,
      { tag: "Replied", id: `event:${event.eventId}`, at: message.occurredAt, text: message.text },
      await transitionFor(deps, run),
    );
  }
};

/**
 * Processes one inbound event. A crash anywhere just means the lease expires and the event is
 * processed again, which the store's idempotency makes harmless. Returns false when idle.
 */
export const dispatchNext = async (deps: EngineDeps, options: EngineOptions): Promise<boolean> => {
  const event = await deps.store.claimEvent(deps.clock.now(), options.eventLeaseMs);
  if (event === null) {
    return false;
  }
  await (event.kind === "comment" ? onComment(deps, event) : onMessage(deps, event));
  await deps.store.completeEvent(event);
  return true;
};
