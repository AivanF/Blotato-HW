import type { Trigger } from "./definition.ts";
import type { Comment } from "./events.ts";

const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive and whole-word: "Pricing?" matches, "repricing" does not. */
export const containsKeyword = (text: string, keyword: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normalize(keyword))}(?![\\p{L}\\p{N}])`, "u").test(
    normalize(text),
  );

export const matchesTrigger = (trigger: Trigger, comment: Comment): boolean =>
  (trigger.posts === "any" || trigger.posts.includes(comment.postId)) &&
  containsKeyword(comment.text, trigger.keyword);

/**
 * First match under the customer's priority order, i.e. the `First` monoid over `Option`.
 * The account's own comments never match, or our replies could retrigger the automation.
 */
export const selectAutomation = <A extends { readonly trigger: Trigger }>(
  byPriority: readonly A[],
  comment: Comment,
  selfAuthorId: string,
): A | null =>
  comment.authorId === selfAuthorId
    ? null
    : (byPriority.find((candidate) => matchesTrigger(candidate.trigger, comment)) ?? null);
