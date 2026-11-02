export type NodeId = string;

/** Text with `{{variable}}` placeholders. */
export type Template = string;

/** What a run does when an effect fails for good: carry on, or end as failed. */
export type OnFailure = "continue" | "abort";

export type EndOutcome = "completed" | "abandoned" | "expired";

export type Trigger = {
  readonly kind: "comment";
  readonly keyword: string;
  readonly posts: "any" | readonly string[];
};

/** Defunctionalized: a tag that survives JSON, applied by `extract`. */
export type ExtractorSpec = { readonly kind: "email" };

export type ReplyToCommentNode = {
  readonly kind: "replyToComment";
  readonly text: Template;
  readonly onFailure: OnFailure;
  readonly next: NodeId;
};

export type SendDmNode = {
  readonly kind: "sendDm";
  readonly text: Template;
  readonly onFailure: OnFailure;
  readonly next: NodeId;
};

export type AwaitReplyNode = {
  readonly kind: "awaitReply";
  readonly extract: ExtractorSpec;
  readonly bindAs: string;
  readonly onMatch: NodeId;
  readonly reprompt: Template;
  /** Invalid replies answered with `reprompt` before moving to `onExhausted`. */
  readonly maxReprompts: number;
  readonly onExhausted: NodeId;
  /** Counted from delivery of the last message sent, not from when it was queued. */
  readonly timeoutMs: number;
  readonly onTimeout: NodeId;
};

export type EndNode = {
  readonly kind: "end";
  readonly outcome: EndOutcome;
};

export type FlowNode = ReplyToCommentNode | SendDmNode | AwaitReplyNode | EndNode;

export type Definition = {
  readonly trigger: Trigger;
  readonly entry: NodeId;
  readonly nodes: Readonly<Record<NodeId, FlowNode>>;
};

declare const validated: unique symbol;

/** A definition `validate` accepted. Only `step` consumes it, which keeps `step` total. */
export type ValidDefinition = Definition & { readonly [validated]: true };

export const lookupNode = (definition: Definition, id: NodeId): FlowNode | undefined =>
  Object.hasOwn(definition.nodes, id) ? definition.nodes[id] : undefined;

export const successors = (node: FlowNode): readonly NodeId[] => {
  switch (node.kind) {
    case "replyToComment":
    case "sendDm":
      return [node.next];
    case "awaitReply":
      return [node.onMatch, node.onExhausted, node.onTimeout];
    case "end":
      return [];
  }
};
