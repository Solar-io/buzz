import type { PulseReactionState } from "./pulseTypes.ts";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { deletedEventIds, reactionTargetId } from "./noteFeed.ts";

/** The one emoji Pulse counts as an upvote, matching the desktop. */
export const UPVOTE_EMOJI = "+";

/**
 * Fold raw `kind:7` events into per-note upvote state.
 *
 * Three things this has to get right, all of which the desktop's Rust side
 * does before the UI ever sees the data:
 *
 *  - only `+` counts (the desktop drops every other emoji in
 *    `usePulseReactionsQuery`);
 *  - a reactor is counted ONCE per note, however many times they reacted —
 *    a re-publish after a reconnect is a duplicate, not a second vote;
 *  - a reaction the author retracted with a `kind:5` does not count, and in
 *    particular must clear `reactedByCurrentUser`, or the heart stays filled
 *    after an un-like until the next reload.
 */
export function foldReactions(
  reactions: readonly SignedNostrEvent[],
  deletions: readonly SignedNostrEvent[],
  currentPubkey: string | null,
): Map<string, PulseReactionState> {
  const retracted = deletedEventIds(deletions);
  const reactorsByNote = new Map<string, Set<string>>();

  for (const reaction of reactions) {
    if (reaction.content !== UPVOTE_EMOJI || retracted.has(reaction.id)) {
      continue;
    }
    const target = reactionTargetId(reaction);
    if (!target) {
      continue;
    }
    let reactors = reactorsByNote.get(target);
    if (!reactors) {
      reactors = new Set<string>();
      reactorsByNote.set(target, reactors);
    }
    reactors.add(reaction.pubkey);
  }

  const state = new Map<string, PulseReactionState>();
  for (const [noteId, reactors] of reactorsByNote) {
    state.set(noteId, {
      count: reactors.size,
      reactedByCurrentUser: currentPubkey ? reactors.has(currentPubkey) : false,
    });
  }
  return state;
}

/**
 * Optimistic local application of an upvote toggle.
 *
 * The count moves only when the viewer's own membership actually changes, so
 * double-clicking the heart cannot inflate it, and it is floored at zero so a
 * retraction against state the relay never confirmed cannot go negative.
 *
 * Ported from `desktop/src/features/pulse/lib/noteActions.ts`.
 */
export function applyReactionState(
  current: ReadonlyMap<string, PulseReactionState> | undefined,
  noteId: string,
  reactedByCurrentUser: boolean,
): Map<string, PulseReactionState> {
  const next = new Map(current);
  const previous = next.get(noteId) ?? {
    count: 0,
    reactedByCurrentUser: false,
  };
  const delta =
    (reactedByCurrentUser && !previous.reactedByCurrentUser ? 1 : 0) -
    (!reactedByCurrentUser && previous.reactedByCurrentUser ? 1 : 0);
  next.set(noteId, {
    count: Math.max(0, previous.count + delta),
    reactedByCurrentUser,
  });
  return next;
}

/**
 * The relay's "you already reacted" rejection, which is a no-op rather than a
 * failure: the desired end state (reacted) already holds.
 */
export function isDuplicateReactionError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.toLowerCase().includes("duplicate: reaction already exists");
}
