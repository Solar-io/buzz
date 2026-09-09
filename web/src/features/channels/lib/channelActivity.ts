/**
 * Newest-message sampling for non-DM channels — the sidebar's unread signal.
 *
 * `channel.updatedAt` comes from the kind:39000 metadata event and new
 * messages never bump it, so a dot keyed on metadata alone can only fire for
 * channels whose DESCRIPTION changed. This module holds the fix's data side:
 * the newest kind:9 message per channel, sampled the same way the DM list
 * samples its recency feed (one batched subscription; see useChannelActivity).
 */

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { isUnread, type ReadState } from "./readState.ts";

/** Chat messages. Reactions, typing and system rows never count as activity. */
const KIND_CHAT_MESSAGE = 9;

/**
 * Cap on the stored preview. Storage stays lean; toast copy truncates tighter
 * (see messageToast.ts) so the ellipsis lands before the toast's own limit.
 */
export const CHANNEL_ACTIVITY_PREVIEW_MAX = 160;

/** Relay NIP-11 max_filters: 10 per REQ (same ceiling the DM sampler packs). */
export const MAX_FILTERS_PER_REQ = 10;

/** The newest sampled message for one channel. */
export interface ChannelActivity {
  channelId: string;
  /** created_at (unix seconds) of the newest sampled message. */
  createdAt: number;
  /** Author pubkey of that message — self-authorship must not read as unread. */
  pubkey: string;
  /** Plain-text excerpt of the message content, markdown stripped. */
  preview: string;
}

export type ChannelActivityMap = Map<string, ChannelActivity>;

export interface ChannelActivityFilter {
  kinds: number[];
  "#h": string[];
  limit: number;
  // Satisfy NostrFilter's tag-index signature without widening the shape.
  [key: `#${string}`]: string[];
}

/**
 * Exact per-channel newest-message sampling as multi-filter REQ batches: one
 * {kinds:[9], #h:[id], limit:1} filter per channel, OR'd into at most
 * MAX_FILTERS_PER_REQ filters per REQ — the DM sampler's packing (a shared
 * limit starves quiet channels; one REQ per channel trips the relay's
 * concurrency limiter and refuses sibling subscriptions).
 */
export function channelActivityFilterBatches(
  channelIds: string[],
): ChannelActivityFilter[][] {
  const batches: ChannelActivityFilter[][] = [];
  for (let i = 0; i < channelIds.length; i += MAX_FILTERS_PER_REQ) {
    batches.push(
      channelIds
        .slice(i, i + MAX_FILTERS_PER_REQ)
        .map((id) => ({ kinds: [KIND_CHAT_MESSAGE], "#h": [id], limit: 1 })),
    );
  }
  return batches;
}

/**
 * Turn a relay kind:9 event into an activity entry. Events without an `h`
 * tag are not channel messages and yield null for the caller to drop.
 */
export function channelActivityFromEvent(
  event: SignedNostrEvent,
): ChannelActivity | null {
  const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (typeof channelId !== "string" || channelId.length === 0) {
    return null;
  }
  return {
    channelId,
    createdAt: event.created_at,
    pubkey: event.pubkey,
    preview: plainPreview(event.content),
  };
}

/**
 * Newest-wins reducer. Returns the SAME map reference when the entry is not
 * strictly newer than the stored sample (stale, duplicate or replayed), so
 * consumers can treat identity as "content changed".
 */
export function applyChannelActivity(
  map: ChannelActivityMap,
  entry: ChannelActivity,
): ChannelActivityMap {
  const previous = map.get(entry.channelId);
  if (previous && previous.createdAt >= entry.createdAt) {
    return map;
  }
  const next = new Map(map);
  next.set(entry.channelId, entry);
  return next;
}

/**
 * The timestamp an unread dot compares against the read marker.
 *
 * Self-authored messages are stored in the feed (they refresh ordering and
 * previews) but must not read as unread: when the newest sample is the
 * viewer's own message, the signal falls back to the channel's metadata
 * time — exactly the pre-activity behaviour. Trade-off: because the feed
 * keeps only the newest sample, "someone else posted, then I posted from
 * another device" hides their still-unread message from the dot until the
 * next foreign message arrives. Under-notifying on that rare cross-device
 * pattern is the conservative side of the brief's "self messages shouldn't
 * count as unread".
 */
export function channelUnreadSignal(input: {
  activity: ChannelActivity | undefined;
  /** Channel metadata (39000) created_at — the pre-activity dot signal. */
  updatedAt: number;
  selfPubkey: string | null;
}): number {
  const { activity, updatedAt, selfPubkey } = input;
  if (!activity || activity.pubkey === selfPubkey) {
    return updatedAt;
  }
  return activity.createdAt;
}

/** Dot decision for a channel/forum/huddle row (mute stays at the call site). */
export function isChannelRowUnread(input: {
  read: ReadState;
  channelId: string;
  updatedAt: number;
  activity: ChannelActivity | undefined;
  selfPubkey: string | null;
}): boolean {
  return isUnread(input.read, input.channelId, channelUnreadSignal(input));
}

/** Strip markdown noise for a one-line preview (mirrors the DM sampler). */
function plainPreview(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "📷 image")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHANNEL_ACTIVITY_PREVIEW_MAX);
}
