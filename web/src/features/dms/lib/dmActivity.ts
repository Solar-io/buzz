import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Last-activity timestamps per DM channel, derived from ONE kind:9
 * subscription spanning all known DM ids (`#h: [id1, id2, …]` — nostr filters
 * are OR within a tag). The subscription is capped (limit ~100) so this is a
 * recency sample for sidebar ordering, not a message cache.
 */
export function dmActivityFromEvents(
  events: SignedNostrEvent[],
): Map<string, number> {
  const activity = new Map<string, number>();
  for (const event of events) {
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (typeof channelId !== "string" || channelId.length === 0) {
      continue;
    }
    const previous = activity.get(channelId) ?? 0;
    if (event.created_at > previous) {
      activity.set(channelId, event.created_at);
    }
  }
  return activity;
}
