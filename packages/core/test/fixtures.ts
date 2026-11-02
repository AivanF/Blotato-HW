import {
  platformId,
  validate,
  type Comment,
  type Definition,
  type MachineConfig,
  type PlatformPolicy,
  type PolicyTarget,
  type ValidDefinition,
} from "../src/index.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Modelled on Instagram's rules: one private reply within 7 days, then a 24h window per reply. */
export const strictPolicy: PlatformPolicy = {
  rateLimits: [],
  dmFromComment: { maxMessages: 1, withinMs: 7 * DAY },
  followUpWindowMs: DAY,
};

export const strictTarget: PolicyTarget = { platform: platformId("strict"), policy: strictPolicy };

export const permissivePolicy: PlatformPolicy = {
  rateLimits: [],
  dmFromComment: { maxMessages: 1_000, withinMs: 365 * DAY },
  followUpWindowMs: null,
};

/** The example from the task. */
export const pricingFlow: Definition = {
  trigger: { kind: "comment", keyword: "pricing", posts: "any" },
  entry: "reply",
  nodes: {
    reply: { kind: "replyToComment", text: "Sent you a DM!", onFailure: "continue", next: "ask" },
    ask: { kind: "sendDm", text: "What's your email?", onFailure: "abort", next: "wait" },
    wait: {
      kind: "awaitReply",
      extract: { kind: "email" },
      bindAs: "email",
      onMatch: "link",
      reprompt: "That doesn't look like an email. Could you resend it?",
      maxReprompts: 1,
      onExhausted: "gaveUp",
      timeoutMs: 72 * HOUR,
      onTimeout: "expired",
    },
    link: {
      kind: "sendDm",
      text: "Thanks {{email}}! https://example.com/pricing",
      onFailure: "abort",
      next: "completed",
    },
    completed: { kind: "end", outcome: "completed" },
    gaveUp: { kind: "end", outcome: "abandoned" },
    expired: { kind: "end", outcome: "expired" },
  },
};

export const mustValidate = (
  definition: Definition,
  targets: readonly PolicyTarget[] = [strictTarget],
): ValidDefinition => {
  const result = validate(definition, targets);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  return result.definition;
};

export const pricingConfig: MachineConfig = {
  definition: mustValidate(pricingFlow),
  policy: strictPolicy,
};

export const T0 = 1_000_000;

export const pricingComment: Comment = {
  commentId: "comment-1",
  postId: "post-1",
  authorId: "user-1",
  text: "pricing please",
  occurredAt: T0,
};
