import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export interface DmLastMessage {
  channelId: string;
  /** Author pubkey of the newest sampled message. */
  authorPubkey: string;
  /** Plain-text excerpt of the newest sampled message content. */
  excerpt: string;
  created_at: number;
}

export interface DmRecencyRank {
  /** Newest sampled message time; 0 when the DM has never been messaged. */
  lastActivity: number;
  /** Channel metadata (39000) time — re-opens bump this without a message. */
  updatedAt: number;
  name: string;
}

/**
 * Most-recent-ACTIVITY ordering for the DM list. A real message beats a
 * metadata touch, so re-opening an old DM cannot float it over a
 * conversation that was actually messaged more recently; never-messaged
 * DMs fall back to their metadata (creation) time, ties break by name.
 */
export function compareDmRecency(
  a: DmRecencyRank,
  b: DmRecencyRank,
): number {
  return (
    (b.lastActivity || b.updatedAt) - (a.lastActivity || a.updatedAt) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Last-activity info per DM channel, derived from ONE kind:9 subscription
 * spanning all known DM ids (`#h: [id1, id2, …]` — nostr filters are OR
 * within a tag). The subscription is capped (limit ~100) so this is a recency
 * sample for sidebar ordering and previews, not a message cache.
 */
export function dmActivityFromEvents(
  events: SignedNostrEvent[],
): Map<string, DmLastMessage> {
  const activity = new Map<string, DmLastMessage>();
  for (const event of events) {
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (typeof channelId !== "string" || channelId.length === 0) {
      continue;
    }
    const previous = activity.get(channelId);
    if (!previous || event.created_at > previous.created_at) {
      activity.set(channelId, {
        channelId,
        authorPubkey: event.pubkey,
        excerpt: plainExcerpt(event.content),
        created_at: event.created_at,
      });
    }
  }
  return activity;
}

/** Strip markdown noise for a one-line sidebar preview. */
function plainExcerpt(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "📷 image")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
