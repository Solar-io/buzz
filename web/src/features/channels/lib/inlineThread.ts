/**
 * Inline threads (web redesign Phase 2): a thread opens IN PLACE under its
 * message — a "N replies · last 3:29 PM" chip, then the replies and a reply
 * box — instead of in a right-pane tab.
 *
 * This module is the pure half: the NIP-10 ref a reply from the inline box
 * carries, the chip's words, and which replies a long thread shows before
 * "Show N earlier". Import-free (types only) so `node --test` loads it.
 */

import type { ThreadReplyRef } from "./threadTarget.ts";

/** The slice of a timeline row the ref is derived from. */
export interface ThreadRowRef {
  id: string;
  rootId: string | null;
  replyToId: string | null;
}

/**
 * The thread ref for a reply typed under `message`.
 *
 * `rootId = message.rootId ?? message.replyToId ?? message.id` — the THREAD
 * ROOT, not the row. A channel row is normally its own root, and then both
 * ids are the row's (one `["e", root, "", "reply"]` tag). But a reply whose
 * root fell outside the buffer renders as a top-level row too, and replying
 * under it must still name the real root: the relay refuses a self-rooted
 * reply to a reply with `invalid: root tag does not match thread ancestry`
 * (AGENTS.md, web send-path traps — caught live, unreachable from a unit
 * suite that does not pin it here).
 */
export function inlineThreadRef(message: ThreadRowRef): ThreadReplyRef {
  return {
    rootId: message.rootId ?? message.replyToId ?? message.id,
    replyToId: message.id,
  };
}

/** Replies shown before "Show N earlier" in a long thread. */
export const INLINE_THREAD_WINDOW = 6;

/**
 * Which replies an expanded thread shows. A thread of up to
 * {@link INLINE_THREAD_WINDOW} replies shows them all; a longer one shows the
 * NEWEST window (the live end of the conversation, next to the reply box)
 * and counts the rest. `showAll` — the "Show N earlier" click, or a permalink
 * to a reply that may sit in the hidden part — lifts the window.
 */
export function inlineThreadWindow<T>(
  replies: readonly T[],
  showAll: boolean,
): { visible: T[]; hidden: number } {
  if (showAll || replies.length <= INLINE_THREAD_WINDOW) {
    return { visible: [...replies], hidden: 0 };
  }
  return {
    visible: replies.slice(replies.length - INLINE_THREAD_WINDOW),
    hidden: replies.length - INLINE_THREAD_WINDOW,
  };
}

/**
 * The chip's count. The relay's thread summary can know about replies the
 * buffer has not loaded, and the buffer can hold replies newer than the
 * summary — so the larger of the two is the honest number.
 */
export function inlineReplyCount(loaded: number, summarized: number): number {
  return Math.max(loaded, summarized);
}

/** "1 reply" / "12 replies". */
export function replyCountLabel(count: number): string {
  return `${count} ${count === 1 ? "reply" : "replies"}`;
}
