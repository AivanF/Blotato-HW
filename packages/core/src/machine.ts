import {
  lookupNode,
  type AwaitReplyNode,
  type EndOutcome,
  type FlowNode,
  type NodeId,
  type OnFailure,
  type ValidDefinition,
} from "./definition.ts";
import type { Comment, Instant } from "./events.ts";
import { contactPatchFor, extract, type ContactPatch } from "./extract.ts";
import type { ActionClass, PlatformPolicy } from "./platform.ts";
import { render, type Bindings } from "./render.ts";

export type MachineConfig = {
  readonly definition: ValidDefinition;
  /** The policy of the platform this run lives on. */
  readonly policy: PlatformPolicy;
};

/** `id` is the deduplication key. The store applies each id at most once per run. */
export type Input =
  | { readonly tag: "Started"; readonly id: string; readonly at: Instant; readonly comment: Comment }
  | { readonly tag: "Replied"; readonly id: string; readonly at: Instant; readonly text: string }
  | { readonly tag: "TimerFired"; readonly id: string; readonly at: Instant }
  | {
      readonly tag: "EffectSettled";
      readonly id: string;
      readonly at: Instant;
      readonly seq: number;
      readonly ok: boolean;
    };

export type Recipient =
  | { readonly kind: "viaComment"; readonly commentId: string }
  | { readonly kind: "contact"; readonly contactId: string };

export type Action =
  | { readonly kind: "replyToComment"; readonly commentId: string; readonly text: string }
  | { readonly kind: "sendDm"; readonly recipient: Recipient; readonly text: string };

export const actionClass = (action: Action): ActionClass => {
  if (action.kind === "replyToComment") return "commentReply";
  return action.recipient.kind === "viaComment" ? "privateReply" : "directMessage";
};

export type Effect = {
  /** Unique within a run, and the order effects must be performed in. */
  readonly seq: number;
  readonly action: Action;
  readonly onFailure: OnFailure;
  /** The platform rejects the send after this, so a backlogged effect should fail instead. */
  readonly notAfter: Instant | null;
};

export type PendingEffect = { readonly seq: number; readonly onFailure: OnFailure };

export type WaitingState = {
  readonly tag: "waiting";
  readonly node: NodeId;
  readonly comment: Comment;
  readonly bindings: Bindings;
  readonly reprompts: number;
  readonly lastReplyAt: Instant | null;
  readonly nextSeq: number;
  readonly pending: readonly PendingEffect[];
  /** The effect whose delivery starts the timeout. Null once that has happened. */
  readonly timerArmedBy: number | null;
  readonly deadline: Instant | null;
};

export type RunOutcome = EndOutcome | "failed";

export type RunState =
  | { readonly tag: "idle" }
  | WaitingState
  | { readonly tag: "done"; readonly outcome: RunOutcome; readonly bindings: Bindings };

export type Transition = {
  readonly state: RunState;
  readonly effects: readonly Effect[];
  /** Saved in the same write as the state, so a crash can't lose a captured email. */
  readonly contact?: ContactPatch;
};

export const initialState: RunState = { tag: "idle" };

/** When a store should deliver `TimerFired`. */
export const wakeAt = (state: RunState): Instant | null =>
  state.tag === "waiting" ? state.deadline : null;

/** What a walk carries from node to node. */
type Cursor = Pick<WaitingState, "comment" | "bindings" | "lastReplyAt" | "nextSeq" | "pending">;

const nodeAt = (definition: ValidDefinition, id: NodeId): FlowNode => {
  const node = lookupNode(definition, id);
  if (node === undefined) {
    throw new Error(`Invariant broken: validated definition has no node "${id}".`);
  }
  return node;
};

const dmRecipient = (cursor: Cursor): Recipient =>
  cursor.lastReplyAt === null
    ? { kind: "viaComment", commentId: cursor.comment.commentId }
    : { kind: "contact", contactId: cursor.comment.authorId };

const dmDeadline = (policy: PlatformPolicy, cursor: Cursor): Instant | null => {
  if (cursor.lastReplyAt !== null) {
    return policy.followUpWindowMs === null ? null : cursor.lastReplyAt + policy.followUpWindowMs;
  }
  return policy.dmFromComment === null
    ? null
    : cursor.comment.occurredAt + policy.dmFromComment.withinMs;
};

const dmEffect = (
  config: MachineConfig,
  cursor: Cursor,
  text: string,
  onFailure: OnFailure,
): Effect => ({
  seq: cursor.nextSeq,
  action: {
    kind: "sendDm",
    recipient: dmRecipient(cursor),
    text: render(text, cursor.bindings),
  },
  onFailure,
  notAfter: dmDeadline(config.policy, cursor),
});

/** Runs nodes until one needs outside input. Validation guarantees that this stops. */
const walk = (config: MachineConfig, from: NodeId, start: Cursor, at: Instant): Transition => {
  const effects: Effect[] = [];
  let cursor = start;
  let id = from;

  const emit = (effect: Effect): void => {
    effects.push(effect);
    cursor = {
      ...cursor,
      nextSeq: cursor.nextSeq + 1,
      pending: [...cursor.pending, { seq: effect.seq, onFailure: effect.onFailure }],
    };
  };

  for (;;) {
    const node = nodeAt(config.definition, id);
    switch (node.kind) {
      case "replyToComment":
        emit({
          seq: cursor.nextSeq,
          action: {
            kind: "replyToComment",
            commentId: cursor.comment.commentId,
            text: render(node.text, cursor.bindings),
          },
          onFailure: node.onFailure,
          notAfter: null,
        });
        id = node.next;
        break;
      case "sendDm":
        emit(dmEffect(config, cursor, node.text, node.onFailure));
        id = node.next;
        break;
      case "awaitReply": {
        const last = effects.at(-1);
        return {
          // The cursor goes first: starting from a waiting state, it still holds that await's fields.
          state: {
            ...cursor,
            tag: "waiting",
            node: id,
            reprompts: 0,
            timerArmedBy: last?.seq ?? null,
            deadline: last === undefined ? at + node.timeoutMs : null,
          },
          effects,
        };
      }
      case "end":
        return {
          state: { tag: "done", outcome: node.outcome, bindings: cursor.bindings },
          effects,
        };
    }
  }
};

const awaitNode = (config: MachineConfig, state: WaitingState): AwaitReplyNode => {
  const node = nodeAt(config.definition, state.node);
  if (node.kind !== "awaitReply") {
    throw new Error(`Invariant broken: run is waiting on "${state.node}" (${node.kind}).`);
  }
  return node;
};

const onReply = (
  config: MachineConfig,
  state: WaitingState,
  input: Extract<Input, { tag: "Replied" }>,
): Transition => {
  const node = awaitNode(config, state);
  const replied: WaitingState = { ...state, lastReplyAt: input.at };
  const value = extract(node.extract, input.text);

  if (value !== null) {
    const bindings = { ...state.bindings, [node.bindAs]: value };
    return {
      ...walk(config, node.onMatch, { ...replied, bindings }, input.at),
      contact: contactPatchFor(node.extract, value),
    };
  }
  if (state.reprompts >= node.maxReprompts) {
    return walk(config, node.onExhausted, replied, input.at);
  }
  // The run depends on the re-prompt reaching the contact, so its failure always aborts.
  const effect = dmEffect(config, replied, node.reprompt, "abort");
  return {
    state: {
      ...replied,
      reprompts: state.reprompts + 1,
      nextSeq: state.nextSeq + 1,
      pending: [...state.pending, { seq: effect.seq, onFailure: effect.onFailure }],
      timerArmedBy: effect.seq,
      deadline: null,
    },
    effects: [effect],
  };
};

const onSettled = (
  config: MachineConfig,
  state: WaitingState,
  input: Extract<Input, { tag: "EffectSettled" }>,
): Transition => {
  const settled = state.pending.find((effect) => effect.seq === input.seq);
  if (settled === undefined) {
    return { state, effects: [] };
  }
  if (!input.ok && settled.onFailure === "abort") {
    return { state: { tag: "done", outcome: "failed", bindings: state.bindings }, effects: [] };
  }
  const arms = state.timerArmedBy === input.seq;
  return {
    state: {
      ...state,
      pending: state.pending.filter((effect) => effect.seq !== input.seq),
      timerArmedBy: arms ? null : state.timerArmedBy,
      deadline: arms ? input.at + awaitNode(config, state).timeoutMs : state.deadline,
    },
    effects: [],
  };
};

/**
 * The transition function of a Mealy machine, and the only place run logic lives. Total: any
 * state accepts any input, and an input with no meaning there changes nothing. Stale timers
 * and late settlements are therefore harmless, and `done` absorbs everything.
 */
export const step = (config: MachineConfig, state: RunState, input: Input): Transition => {
  const unchanged: Transition = { state, effects: [] };
  switch (state.tag) {
    case "done":
      return unchanged;
    case "idle":
      return input.tag === "Started"
        ? {
            ...walk(
              config,
              config.definition.entry,
              {
                comment: input.comment,
                bindings: {},
                lastReplyAt: null,
                nextSeq: 0,
                pending: [],
              },
              input.at,
            ),
            contact:
              input.comment.authorName === undefined ? {} : { nickname: input.comment.authorName },
          }
        : unchanged;
    case "waiting":
      switch (input.tag) {
        case "Started":
          return unchanged;
        case "Replied":
          return onReply(config, state, input);
        case "EffectSettled":
          return onSettled(config, state, input);
        case "TimerFired":
          return state.deadline !== null && input.at >= state.deadline
            ? walk(config, awaitNode(config, state).onTimeout, state, input.at)
            : unchanged;
      }
  }
};

/** Folds inputs over `step`, skipping repeated ids as a store does. Used for replay and audit. */
export const replay = (
  config: MachineConfig,
  inputs: readonly Input[],
  from: RunState = initialState,
): Transition => {
  const seen = new Set<string>();
  const effects: Effect[] = [];
  let state = from;
  let contact: ContactPatch | undefined;
  for (const input of inputs) {
    if (!seen.has(input.id)) {
      seen.add(input.id);
      const next = step(config, state, input);
      state = next.state;
      effects.push(...next.effects);
      if (next.contact !== undefined) {
        contact = { ...contact, ...next.contact };
      }
    }
  }
  return contact === undefined ? { state, effects } : { state, effects, contact };
};
