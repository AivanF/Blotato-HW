import type { PlatformId } from "./platform.ts";

/** Milliseconds since the Unix epoch. Always passed in, so the core never reads a clock. */
export type Instant = number;

export type Comment = {
  readonly commentId: string;
  readonly postId: string;
  readonly authorId: string;
  readonly text: string;
  readonly occurredAt: Instant;
};

export type Message = {
  readonly senderId: string;
  readonly text: string;
  readonly occurredAt: Instant;
};

/** The canonical form every transport and platform decoder converges on. */
export type InboundEvent = {
  readonly platform: PlatformId;
  readonly accountId: string;
  readonly eventId: string;
} & (({ readonly kind: "comment" } & Comment) | ({ readonly kind: "message" } & Message));
