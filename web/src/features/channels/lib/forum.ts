import type { MessageBuffer, TimelineMessage } from "./messageBuffer.ts";

/** Kind 45001 — forum post (top-level: h tag + mentions/media, no e tags). */
export const FORUM_POST_KIND = 45001;
/** Kind 45003 — forum comment (h tag + NIP-10 root/reply e markers). */
export const FORUM_COMMENT_KIND = 45003;

/**
 * Kinds that can stand as a forum thread root. Desktop's forum list queries
 * kind 45001 only; the web read side deliberately widens this to the chat
 * root kinds because the live relay holds zero 45001/45003 today — channels
 * like #alerts post kind-9 thread roots, and those must render as posts.
 */
const THREAD_ROOT_KINDS = new Set([9, 40002, 40008, FORUM_POST_KIND]);

/**
 * A message that opens its own forum thread: no NIP-10 root/reply markers
 * and a kind that can start a conversation. Overlay kinds (40003 edit, 5
 * delete) and reaction kind 7 never qualify; a 45003 comment always carries
 * e markers, so it is excluded by the marker check, not by its kind.
 */
export function isForumThreadRoot(message: TimelineMessage): boolean {
  return (
    message.rootId === null &&
    message.replyToId === null &&
    THREAD_ROOT_KINDS.has(message.kind)
  );
}

/** Forum posts in a buffer, newest first. */
export function forumPosts(buffer: MessageBuffer): TimelineMessage[] {
  return buffer
    .filter((message) => isForumThreadRoot(message))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Replies of one forum thread, oldest first. Both marker shapes match: a
 * kind-45003 comment with root+reply markers (rootId set) and a kind-9
 * append with a bare single e tag (replyToId only).
 */
export function forumThreadReplies(
  buffer: MessageBuffer,
  rootId: string,
): TimelineMessage[] {
  return buffer
    .filter(
      (message) => message.rootId === rootId || message.replyToId === rootId,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}
