import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Kind-7 reactions (NIP-25 shape used by Buzz: content = emoji, one e tag
 * naming the target message). Aggregated per target message id.
 */

export interface ReactionGroup {
  emoji: string;
  /** Pubkeys that reacted with this emoji (deduped). */
  pubkeys: string[];
}

export type ReactionIndex = Map<string, Map<string, string[]>>;

/** Parse a kind-7 event: the target id (e tag) and the emoji (content). */
export function reactionFromEvent(
  event: SignedNostrEvent,
): { targetId: string; emoji: string } | null {
  if (event.kind !== 7) {
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

/** Ordered groups for one target, most-reacted first. */
export function reactionGroups(
  index: ReactionIndex,
  targetId: string,
): ReactionGroup[] {
  const byEmoji = index.get(targetId);
  if (!byEmoji) {
    return [];
  }
  return [...byEmoji.entries()]
    .map(([emoji, pubkeys]) => ({ emoji, pubkeys }))
    .sort((a, b) => b.pubkeys.length - a.pubkeys.length);
}

/** Quick-reaction set shown on hover (desktop useQuickReactionEmojis shape). */
export const QUICK_REACTIONS = ["👍", "🔥", "😂", "❤️", "🎉"] as const;
