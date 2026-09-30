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
import type { MessageBuffer, TimelineMessage } from "./messageBuffer.ts";

/** A malformed parent cycle must not spin forever. */
const MAX_THREAD_HOPS = 100;

/**
 * Which top-level row each reply folds under, and each row's replies.
 *
 * The channel timeline shows one row per conversation and every reply inside
 * its row's inline thread — so ONE function has to answer both "is this
 * message a row?" and "whose thread is it in?", or a message could be hidden
 * from the top level and absent from every thread (or shown in both).
 *
 * A reply's row is its NIP-10 root when that root is loaded. Otherwise it is
 * the top of its loaded parent chain — a reply to a reply whose root fell
 * outside the buffer folds under the oldest ancestor that IS loaded, which
 * renders as a row of its own. A reply with no loaded ancestor at all is a
 * row too (an orphan): the newest message is always visible somewhere.
 *
 * `replies` lists each row's replies oldest first, deleted ones dropped;
 * `rowOf` maps every folded message (deleted included — a tombstoned reply
 * must not resurface as a row) to the row it folds under.
 */
export function foldReplies(messages: MessageBuffer): {
  rowOf: Map<string, string>;
  replies: Map<string, TimelineMessage[]>;
} {
  const byId = new Map<string, TimelineMessage>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  const rowOf = new Map<string, string>();
  const replies = new Map<string, TimelineMessage[]>();
  for (const message of messages) {
    let row: string | null = null;
    if (
      message.rootId &&
      message.rootId !== message.id &&
      byId.has(message.rootId)
    ) {
      row = message.rootId;
    } else {
      let current = message;
      for (let hops = 0; hops < MAX_THREAD_HOPS; hops += 1) {
        const parentId = current.replyToId ?? current.rootId;
        const parent =
          parentId && parentId !== current.id ? byId.get(parentId) : undefined;
        if (!parent || parent.id === message.id) {
          break;
        }
        row = parent.id;
        current = parent;
      }
    }
    if (row === null) {
      continue;
    }
    rowOf.set(message.id, row);
    if (message.deleted) {
      continue;
    }
    const list = replies.get(row);
    if (list) {
      list.push(message);
    } else {
      replies.set(row, [message]);
    }
  }
  for (const list of replies.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return { rowOf, replies };
}

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
