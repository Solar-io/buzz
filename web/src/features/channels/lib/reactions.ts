import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Kind-7 reactions (NIP-25 shape used by Buzz: content = emoji, one e tag
 * naming the target message). Aggregated per target message id.
 */

/** NIP-25 reaction. `buzz_core::kind::KIND_REACTION`. */
export const REACTION_KIND = 7;
/**
 * NIP-09 deletion. `buzz_core::kind::KIND_DELETION`.
 *
 * Removing a reaction is NOT a second kind-7 — it is a kind-5 whose single
 * `e` tag names the reactor's OWN kind-7 event id. Verified against
 * `desktop/src-tauri/src/events.rs::build_remove_reaction` (kind 5, one e
 * tag, empty content) and the relay's ingest path:
 * `handlers/side_effects.rs::validate_standard_deletion_event` rejects a
 * deletion whose target was authored by anyone but the actor, and
 * `handlers/ingest.rs` rejects any deletion that does not reference exactly
 * one target via an `e` or `a` tag. The kind-5 carries no `h` tag; the relay
 * derives the channel from the target event.
 */
export const REACTION_DELETE_KIND = 5;

export interface ReactionGroup {
  emoji: string;
  /** Pubkeys that reacted with this emoji (deduped). */
  pubkeys: string[];
  /**
   * The viewer is among `pubkeys`. Drives the filled chip and `aria-pressed`,
   * and decides whether a click adds a reaction or removes the viewer's own.
   */
  reactedByCurrentUser: boolean;
}

export type ReactionIndex = Map<string, Map<string, string[]>>;

/** Parse a kind-7 event: the target id (e tag) and the emoji (content). */
export function reactionFromEvent(
  event: SignedNostrEvent,
): { targetId: string; emoji: string } | null {
  if (event.kind !== REACTION_KIND) {
    return null;
  }
  const targetId = event.tags.find((tag) => tag[0] === "e")?.[1];
  const emoji = event.content.trim();
  if (!targetId || !emoji) {
    return null;
  }
  return { targetId, emoji };
}

/** Upsert one reaction event into the index. */
export function upsertReaction(
  index: ReactionIndex,
  reaction: { targetId: string; emoji: string },
  authorPubkey: string,
): ReactionIndex {
  const byEmoji = index.get(reaction.targetId) ?? new Map<string, string[]>();
  const pubkeys = byEmoji.get(reaction.emoji) ?? [];
  if (!pubkeys.includes(authorPubkey)) {
    byEmoji.set(reaction.emoji, [...pubkeys, authorPubkey]);
  }
  const next = new Map(index);
  next.set(reaction.targetId, byEmoji);
  return next;
}

/**
 * Drop one author's reaction from the index — the local half of a removal,
 * applied optimistically so the chip clears before the relay echoes the
 * kind-5 back. Returns the SAME reference when nothing matched, so a React
 * state update is a no-op for a reaction this client never saw. An emoji
 * whose last reactor is removed loses its entry entirely (an empty group must
 * not render a zero-count chip), and a target with no emoji left loses its
 * entry too.
 */
export function removeReaction(
  index: ReactionIndex,
  targetId: string,
  emoji: string,
  authorPubkey: string,
): ReactionIndex {
  const byEmoji = index.get(targetId);
  const pubkeys = byEmoji?.get(emoji);
  if (!byEmoji || !pubkeys?.includes(authorPubkey)) {
    return index;
  }
  const remaining = pubkeys.filter((pubkey) => pubkey !== authorPubkey);
  const nextByEmoji = new Map(byEmoji);
  if (remaining.length === 0) {
    nextByEmoji.delete(emoji);
  } else {
    nextByEmoji.set(emoji, remaining);
  }
  const next = new Map(index);
  if (nextByEmoji.size === 0) {
    next.delete(targetId);
  } else {
    next.set(targetId, nextByEmoji);
  }
  return next;
}

/**
 * Ordered groups for one target, most-reacted first.
 *
 * `selfPubkey` is optional so callers that have no viewer identity (the forum
 * feed rows) keep compiling and simply get `reactedByCurrentUser: false`. It
 * lives on the group rather than in {@link ReactionIndex} deliberately: the
 * index is persisted to IndexedDB by the timeline cache and consumed by the
 * relay ingest path, so widening it would change a stored format for what is
 * pure derived state — and every chip render site would otherwise repeat the
 * same `pubkeys.includes(self)` by hand.
 */
export function reactionGroups(
  index: ReactionIndex,
  targetId: string,
  selfPubkey?: string | null,
): ReactionGroup[] {
  const byEmoji = index.get(targetId);
  if (!byEmoji) {
    return [];
  }
  return [...byEmoji.entries()]
    .map(([emoji, pubkeys]) => ({
      emoji,
      pubkeys,
      reactedByCurrentUser:
        selfPubkey != null && selfPubkey !== "" && pubkeys.includes(selfPubkey),
    }))
    .sort((a, b) => b.pubkeys.length - a.pubkeys.length);
}

/** Cap on names listed in a chip tooltip before it collapses to a count. */
const MAX_NAMED_REACTORS = 8;

/**
 * Human sentence naming who reacted, for a chip's `title`. The viewer sorts
 * first as "You", matching the desktop's reaction popover.
 */
export function describeReactors(
  group: ReactionGroup,
  nameOf: (pubkey: string) => string,
  selfPubkey?: string | null,
): string {
  const others = group.pubkeys
    .filter((pubkey) => pubkey !== selfPubkey)
    .map(nameOf);
  const names = group.reactedByCurrentUser ? ["You", ...others] : others;
  if (names.length === 0) {
    return group.emoji;
  }
  const listed =
    names.length > MAX_NAMED_REACTORS
      ? [
          ...names.slice(0, MAX_NAMED_REACTORS),
          `${names.length - MAX_NAMED_REACTORS} more`,
        ]
      : names;
  const joined =
    listed.length === 1
      ? listed[0]
      : listed.length === 2
        ? `${listed[0]} and ${listed[1]}`
        : `${listed.slice(0, -1).join(", ")}, and ${listed[listed.length - 1]}`;
  return `${joined} reacted with ${group.emoji}`;
}

/**
 * The viewer's own kind-7 event id for one (target, emoji) pair — the id a
 * removal's kind-5 must name.
 *
 * Same selection the desktop's `remove_reaction` Tauri command performs after
 * its `{"kinds":[7],"#e":[target],"authors":[me]}` query: own author, the
 * target in an `e` tag, trimmed content equal to the emoji. Ties break on the
 * newest event so a duplicate reaction (two clients, one author) deletes the
 * one the relay is most likely still serving.
 */
export function pickOwnReactionEventId(
  events: readonly SignedNostrEvent[],
  target: { targetEventId: string; emoji: string; selfPubkey: string },
): string | null {
  const wanted = target.emoji.trim();
  let best: SignedNostrEvent | null = null;
  for (const event of events) {
    if (event.kind !== REACTION_KIND || event.pubkey !== target.selfPubkey) {
      continue;
    }
    if (event.content.trim() !== wanted) {
      continue;
    }
    const hitsTarget = event.tags.some(
      (tag) => tag[0] === "e" && tag[1] === target.targetEventId,
    );
    if (!hitsTarget) {
      continue;
    }
    if (!best || event.created_at > best.created_at) {
      best = event;
    }
  }
  return best?.id ?? null;
}

/**
 * REQ filter that finds the viewer's own reactions on one message — the same
 * `{"kinds":[7],"#e":[target],"authors":[me]}` the desktop's `remove_reaction`
 * issues before it can name a deletion target.
 */
export function ownReactionFilter(
  targetEventId: string,
  selfPubkey: string,
): { kinds: number[]; "#e": string[]; authors: string[] } {
  return {
    kinds: [REACTION_KIND],
    "#e": [targetEventId],
    authors: [selfPubkey],
  };
}

/**
 * The unsigned kind-5 that removes one reaction.
 *
 * Exactly one `e` tag and no `h` tag, both required by the relay: ingest
 * rejects a deletion referencing anything but a single target, and derives
 * the channel from the target event rather than from an h tag. Content is
 * empty, matching `build_remove_reaction`.
 */
export function buildReactionDeleteTemplate(reactionEventId: string): {
  kind: number;
  tags: string[][];
  content: string;
} {
  return {
    kind: REACTION_DELETE_KIND,
    tags: [["e", reactionEventId]],
    content: "",
  };
}

/** Quick-reaction set shown on hover (desktop useQuickReactionEmojis shape). */
export const QUICK_REACTIONS = ["👍", "🔥", "😂", "❤️", "🎉"] as const;
