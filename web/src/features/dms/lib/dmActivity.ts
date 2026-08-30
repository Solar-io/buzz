import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export interface DmLastMessage {
  channelId: string;
  /** Author pubkey of the newest sampled message. */
  authorPubkey: string;
  /** Plain-text excerpt of the newest sampled message content. */
  excerpt: string;
  created_at: number;
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
