import type { PulseNote } from "./pulseTypes.ts";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/** Normalise one signed `kind:1` event into the feed's note shape. */
export function noteFromEvent(event: SignedNostrEvent): PulseNote {
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    content: event.content,
    tags: event.tags,
  };
}

/**
 * Newest-first, with a deterministic tiebreak.
 *
 * `created_at` collides constantly — an agent that posts a burst stamps
 * several notes in the same second — and a comparator that returns 0 there
 * leaves the order at the mercy of relay delivery sequence, which changes
 * between a stored replay and a live push. The id tiebreak makes the feed
 * stable across both, which is also what makes the virtual list's keys stop
 * jumping.
 */
export function sortNotesNewestFirst(notes: readonly PulseNote[]): PulseNote[] {
  return [...notes].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

/**
 * Collapse duplicate ids, keeping the FIRST occurrence.
 *
 * A relay replays stored events on reconnect and can re-push one that already
 * arrived live, so the same id lands twice in a single feed accumulation.
 */
export function dedupeNotes(notes: readonly PulseNote[]): PulseNote[] {
  const seen = new Set<string>();
  const result: PulseNote[] = [];
  for (const note of notes) {
    if (seen.has(note.id)) {
      continue;
    }
    seen.add(note.id);
    result.push(note);
  }
  return result;
}

/** Deduplicate then order — the shape every tab hands to the list. */
export function toFeed(notes: readonly PulseNote[]): PulseNote[] {
  return dedupeNotes(sortNotesNewestFirst(notes));
}

/**
 * The event id a `kind:7` reaction points at: the LAST `e` tag, per NIP-25.
 *
 * Mirrors `last_event_tag_id` in
 * `desktop/src-tauri/src/commands/social.rs`, which the Liked tab depends on
 * — a reaction to a reply carries the root's `e` tag first and the reacted-to
 * event last, so taking the first tag likes the wrong note.
 */
export function reactionTargetId(event: SignedNostrEvent): string | null {
  for (let index = event.tags.length - 1; index >= 0; index -= 1) {
    const tag = event.tags[index];
    if (tag[0] === "e" && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

/** Every event id a set of `kind:5` deletion requests retracts. */
export function deletedEventIds(
  deletions: readonly SignedNostrEvent[],
): Set<string> {
  const ids = new Set<string>();
  for (const deletion of deletions) {
    for (const tag of deletion.tags) {
      if (tag[0] === "e" && tag[1]) {
        ids.add(tag[1]);
      }
    }
  }
  return ids;
}

/**
 * The Liked tab's target list: for each of the viewer's own `kind:7`
 * reactions, newest first, the note it targets — skipping reactions the
 * viewer has since retracted with a `kind:5`, and keeping only the first
 * (newest) reaction per target.
 *
 * Returns both the ordered ids and, for each, when it was liked, because the
 * subsequent `kind:1` fetch comes back in relay order and has to be re-sorted
 * by like time to match what the desktop shows.
 */
export function likedTargets(
  reactions: readonly SignedNostrEvent[],
  deletions: readonly SignedNostrEvent[],
  cap: number,
): { ids: string[]; likedAt: Map<string, number> } {
  const retracted = deletedEventIds(deletions);
  const ordered = [...reactions].sort(
    (left, right) =>
      right.created_at - left.created_at || left.id.localeCompare(right.id),
  );

  const ids: string[] = [];
  const likedAt = new Map<string, number>();
  for (const reaction of ordered) {
    if (ids.length >= cap) {
      break;
    }
    if (retracted.has(reaction.id)) {
      continue;
    }
    const target = reactionTargetId(reaction);
    if (!target || likedAt.has(target)) {
      continue;
    }
    likedAt.set(target, reaction.created_at);
    ids.push(target);
  }
  return { ids, likedAt };
}

/** Order fetched notes by when the viewer liked them, newest like first. */
export function orderByLikedAt(
  notes: readonly PulseNote[],
  likedAt: ReadonlyMap<string, number>,
): PulseNote[] {
  return [...notes].sort(
    (left, right) =>
      (likedAt.get(right.id) ?? 0) - (likedAt.get(left.id) ?? 0) ||
      left.id.localeCompare(right.id),
  );
}
