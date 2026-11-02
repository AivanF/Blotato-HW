/** Opaque on purpose: the core can carry a platform id but has no reason to branch on one. */
export type PlatformId = string & { readonly __brand: "PlatformId" };

export const platformId = (id: string): PlatformId => id as PlatformId;

/** Platforms limit these separately. A DM sent through a comment is a private reply. */
export type ActionClass = "commentReply" | "privateReply" | "directMessage";

export type RateLimit = {
  readonly action: ActionClass;
  /** No more than this many sends in any window of `perMs`, per account. */
  readonly max: number;
  readonly perMs: number;
};

/** A platform's messaging rules as data, so no platform name appears in the core's logic. */
export type PlatformPolicy = {
  readonly rateLimits: readonly RateLimit[];
  /** DMs allowed to a commenter who has not replied yet. Null means none at all. */
  readonly dmFromComment: { readonly maxMessages: number; readonly withinMs: number } | null;
  /** How long after a contact's reply we may still DM them. Null means no limit. */
  readonly followUpWindowMs: number | null;
};

export type PolicyTarget = {
  readonly platform: PlatformId;
  readonly policy: PlatformPolicy;
};
