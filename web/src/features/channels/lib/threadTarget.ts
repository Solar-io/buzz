/**
 * Which message a thread reply is actually a reply TO.
 *
 * NIP-10's marked scheme is explicit: the `reply`-marked `e` tag "denote[s] the
 * id of the reply event being responded to" — the IMMEDIATE PARENT the author
 * chose. It is not "the most recent event in the thread". The panel used to
 * hardcode `replies[replies.length - 1]`, which made every reply claim the
 * newest message as its parent and made replying mid-thread impossible.
 *
 * Default target is the thread ROOT, matching the desktop client
 * (`parentEventId: replyTargetMessageRef.current?.id ?? threadHeadId` in
 * MessageThreadPanel.tsx, and `replyTargetInBranch ?? normalizedThreadHead` in
 * threadPanel.ts). Semantically it is also the only defensible default: with no
 * explicit selection the author is replying to the thread itself, and the
 * thread is named by its root.
 *
 * Note on the wire shape: NIP-10 says a direct reply to the root "should have a
 * single marked 'e' tag of type 'root'". Buzz instead collapses that case to a
 * single `["e", <root>, "", "reply"]` — see `sendChannelMessage`/
 * `buildReplyTags` and NOSTR.md, and the relay's thread_metadata derivation
 * depends on it. This module produces the ref; it deliberately does not change
 * that shipped tag convention.
 */

import type { MessageBuffer, TimelineMessage } from "./messageBuffer.ts";

export interface ThreadReplyRef {
  rootId: string;
  replyToId: string;
}

/**
 * Replies belonging to a thread root, oldest first. Matches the buffer's own
 * `threadReplies`: a reply either names the root explicitly or (single-e-tag
 * shape) names it as its only parent.
 */
export function threadRepliesOf(
  buffer: MessageBuffer,
  rootId: string,
): TimelineMessage[] {
  return buffer
    .filter(
      (m) =>
        m.rootId === rootId || (m.rootId === null && m.replyToId === rootId),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Resolve the NIP-10 ref for the composer.
 *
 * `selectedId` is the message the user picked to reply to. It is honoured only
 * when it is genuinely part of this thread (the root itself, or one of its
 * replies) — a stale selection left over from another thread must never leak a
 * foreign parent id onto the wire. Anything else falls back to the root.
 */
export function resolveThreadReplyRef(
  rootId: string,
  replies: readonly TimelineMessage[],
  selectedId: string | null | undefined,
): ThreadReplyRef {
  if (!selectedId || selectedId === rootId) {
    return { rootId, replyToId: rootId };
  }
  const selected = replies.some((reply) => reply.id === selectedId);
  return { rootId, replyToId: selected ? selectedId : rootId };
}

/**
 * The message the composer banner should name, or null when the target is the
 * root (replying to the thread itself needs no callout). Keeps the selection
 * visible instead of leaving it as invisible state.
 */
export function replyTargetMessage(
  rootId: string,
  replies: readonly TimelineMessage[],
  selectedId: string | null | undefined,
): TimelineMessage | null {
  if (!selectedId || selectedId === rootId) {
    return null;
  }
  return replies.find((reply) => reply.id === selectedId) ?? null;
}
