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

/**
 * Per-channel window size for the counting feed: `{since: marker, limit: 200}`
 * per channel (the DM unread-count hook's bounded one-shot shape). A
 * never-read channel (marker ?? 0) can hold more unread than this; its count
 * caps at what the window returns and the display caps that in turn.
 */
export const UNREAD_COUNT_SAMPLE_LIMIT = 200;

/**
 * Ceiling on the in-memory per-channel sample buffer the counting feed keeps
 * between EOSEs. Reconnects re-REQ the window and re-derive the count from
 * the buffer, so it must out-size UNREAD_COUNT_SAMPLE_LIMIT by a live-arrival
 * margin; beyond it the newest events are kept and the derived count is
 * display-capped anyway.
 */
export const UNREAD_COUNT_BUFFER_MAX = 250;

/** Numbers 1..99 render as-is; anything larger renders as "99+". */
export const UNREAD_COUNT_CAP = 99;

/** Live unread counts per channel, derived from the counting feed. */
export type ChannelUnreadCounts = Map<string, number>;

/** The two fields of a sampled message the unread count derives from. */
export interface UnreadCountEvent {
  pubkey: string;
  createdAt: number;
}

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
  /** Counting mode only: the read marker the window opens at. */
  since?: number;
  limit: number;
  // Satisfy NostrFilter's tag-index signature without widening the shape.
  [key: `#${string}`]: string[];
}

/**
 * Exact per-channel newest-message sampling as multi-filter REQ batches: one
 * per-channel filter OR'd into at most MAX_FILTERS_PER_REQ filters per REQ —
 * the DM sampler's packing (a shared limit starves quiet channels; one REQ
 * per channel trips the relay's concurrency limiter and refuses sibling
 * subscriptions).
 *
 * Two modes, keyed on `readMarkers`:
 * - Sampling (no markers): `{kinds:[9], #h:[id], limit:1}` — newest message
 *   per channel only. The toast feeds use this; they never need counts.
 * - Counting (markers given): `{kinds:[9], #h:[id], since: marker ?? 0,
 *   limit: UNREAD_COUNT_SAMPLE_LIMIT}` — the DM unread-count hook's bounded
 *   window, kept live, so the sidebar can count foreign messages newer than
 *   each channel's read marker.
 */
export function channelActivityFilterBatches(
  channelIds: string[],
  readMarkers?: ReadState,
): ChannelActivityFilter[][] {
  const batches: ChannelActivityFilter[][] = [];
  for (let i = 0; i < channelIds.length; i += MAX_FILTERS_PER_REQ) {
    batches.push(
      channelIds.slice(i, i + MAX_FILTERS_PER_REQ).map((id) =>
        readMarkers
          ? {
              kinds: [KIND_CHAT_MESSAGE],
              "#h": [id],
              since: readMarkers[id] ?? 0,
              limit: UNREAD_COUNT_SAMPLE_LIMIT,
            }
          : { kinds: [KIND_CHAT_MESSAGE], "#h": [id], limit: 1 },
      ),
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
 * Derive a channel's unread count from its sampled window: the number of
 * events authored by someone else strictly after the read marker. A null
 * `selfPubkey` (locked key) cannot exclude anyone, so everything
 * post-marker counts — a transient over-count until identity lands and the
 * feed re-derives.
 */
export function countUnreadFromEvents(
  events: UnreadCountEvent[],
  marker: number,
  selfPubkey: string | null,
): number {
  let count = 0;
  for (const event of events) {
    if (event.pubkey !== selfPubkey && event.createdAt > marker) {
      count += 1;
    }
  }
  return count;
}

/**
 * Live-arrival increment for one channel's count. The feed only reaches this
 * after its strictly-newer guard (see useChannelActivity), but the exclusion
 * rules live here so they are testable: the viewer's own messages refresh
 * the sample yet never count, and an arrival at-or-below the marker is read.
 */
export function incrementUnreadCount(
  count: number | undefined,
  arrival: UnreadCountEvent,
  marker: number,
  selfPubkey: string | null,
): number {
  if (arrival.pubkey === selfPubkey || arrival.createdAt <= marker) {
    return count ?? 0;
  }
  return (count ?? 0) + 1;
}

/**
 * Zero the counts of channels whose read marker advanced (the viewer opened
 * the channel or marked it read) — the badge must vanish immediately, not
 * wait for the re-REQ's EOSE. Returns the SAME map when no subscribed
 * channel's marker moved.
 */
export function resetCountsForMarkerChanges(
  counts: ChannelUnreadCounts,
  previousMarkers: ReadState,
  nextMarkers: ReadState,
): ChannelUnreadCounts {
  let changed = false;
  const next = new Map(counts);
  for (const [channelId, marker] of Object.entries(nextMarkers)) {
    if (
      (previousMarkers[channelId] ?? 0) < (marker ?? 0) &&
      next.has(channelId)
    ) {
      next.set(channelId, 0);
      changed = true;
    }
  }
  return changed ? next : counts;
}

/** Badge copy: the number through the cap, then the capped "99+" form. */
export function formatUnreadCount(count: number): string {
  return count > UNREAD_COUNT_CAP ? `${UNREAD_COUNT_CAP}+` : String(count);
}

/** Shared state one counting feed's sibling batch subscriptions mutate. */
export interface ChannelActivityHandlerDeps {
  /** Newest-wins sample map, shared across the feed's batch subscriptions. */
  activityRef: { current: ChannelActivityMap };
  /** Publish the mutated sample map (the hook's setActivity). */
  onActivityChange: (map: ChannelActivityMap) => void;
  /** A LIVE strictly-newer arrival that beat a known sample (toast path). */
  onLiveArrival: (entry: ChannelActivity) => void;
  /** Functional count update (the hook's setUnreadCounts). */
  onUnreadCountsChange: (
    updater: (previous: ChannelUnreadCounts) => ChannelUnreadCounts,
  ) => void;
  /** null readMarkers = sampling mode: newest-message samples, no counts. */
  readMarkers: ReadState | null;
  selfPubkey: string | null;
}

/** The SubscribeOptions-shaped pair the relay session calls into. */
export interface ChannelActivitySubscriptionHandlers {
  onEvent: (event: SignedNostrEvent) => void;
  onEose: () => void;
}

/**
 * One batch subscription's event/EOSE handlers — the counting feed's whole
 * event chain as a unit the tests can drive directly (no React, no replica:
 * this is the object the hook hands `session.subscribe`, and the object the
 * relay's reconnect replay re-delivers through).
 *
 * Counting semantics across delivery rounds. The relay re-REQs a
 * subscription after every reconnect and re-delivers its whole since-window,
 * so an event can arrive any number of times over the subscription's life.
 * Exactly-once counting therefore leans on the newest-wins sample map, which
 * drops every arrival at-or-below the stored sample:
 *
 * - BACKFILL ROUND (subscription open until its first EOSE): arrivals
 *   buffer per channel (bounded); the first EOSE derives each channel's
 *   count from that window. Out-of-order arrivals that beat a surviving
 *   sample can transiently bump the count first — the derivation replaces
 *   it, which is what makes a mid-backfill bump self-correcting.
 * - LIVE (after the first EOSE): strictly-newer foreign arrivals increment
 *   only. They must NOT buffer: a later reconnect re-delivers them (they
 *   still match `since`), they arrive at-or-below the sample by then, and
 *   the replayed round must be able to ignore them — buffering them here
 *   would make the next derivation count them twice.
 * - REPLAY ROUNDS (every round after the first): re-delivered arrivals are
 *   dropped by the sample map, and EOSEs derive nothing — the count keeps
 *   its live-incremented value. An event the client MISSED while offline
 *   still beats the sample, increments once, and is never double-counted.
 *
 * A marker change re-runs the owning effect with fresh handlers, so the new
 * windows re-enter backfill and re-derive at their EOSE (see
 * useChannelActivity).
 */
export function createChannelActivityHandlers(
  deps: ChannelActivityHandlerDeps,
): ChannelActivitySubscriptionHandlers {
  const {
    activityRef,
    onActivityChange,
    onLiveArrival,
    onUnreadCountsChange,
    readMarkers,
    selfPubkey,
  } = deps;
  let window: Map<string, UnreadCountEvent[]> | null = readMarkers
    ? new Map()
    : null;
  let backfillClosed = false;

  return {
    onEvent(event: SignedNostrEvent): void {
      const entry = channelActivityFromEvent(event);
      if (!entry) {
        return;
      }
      // Buffer BEFORE the strictly-newer guard: the backfill derivation
      // counts the delivered window, and most of that window is at-or-below
      // the newest sample by definition. Stale/duplicate arrivals land here
      // and are then dropped from the sample path below.
      if (window && !backfillClosed) {
        const samples = window.get(entry.channelId) ?? [];
        samples.push(entry);
        window.set(entry.channelId, samples.slice(-UNREAD_COUNT_BUFFER_MAX));
      }
      const previous = activityRef.current.get(entry.channelId);
      // Strictly newer wins: stale, duplicate and reconnect-replayed
      // events (same created_at as the stored sample) are dropped here.
      if (previous && previous.createdAt >= entry.createdAt) {
        return;
      }
      if (previous) {
        if (readMarkers) {
          // Live increment, same exclusion rules as the derivation.
          onUnreadCountsChange((counts) => {
            const next = new Map(counts);
            next.set(
              entry.channelId,
              incrementUnreadCount(
                counts.get(entry.channelId),
                entry,
                readMarkers[entry.channelId] ?? 0,
                selfPubkey,
              ),
            );
            return next;
          });
        }
        onLiveArrival(entry);
      }
      activityRef.current = applyChannelActivity(activityRef.current, entry);
      onActivityChange(activityRef.current);
    },
    onEose(): void {
      if (!readMarkers || !window || backfillClosed) {
        return;
      }
      // Derive each buffered channel's count from its backfill window.
      // REPLACES any transiently-bumped value — the count is the window's
      // truth, not the increments' sum.
      const buffered = window;
      onUnreadCountsChange((previous) => {
        const next = new Map(previous);
        for (const [channelId, samples] of buffered) {
          next.set(
            channelId,
            countUnreadFromEvents(
              samples,
              readMarkers[channelId] ?? 0,
              selfPubkey,
            ),
          );
        }
        return next;
      });
      // The backfill round ends here, for good: replay rounds re-deliver
      // this same window and must find nothing left to derive, or every
      // reconnect would re-add the round's events to the count.
      backfillClosed = true;
      window = new Map();
    },
  };
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
