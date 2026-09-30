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
import { plainText } from "../../../shared/lib/plainText.ts";
import { isUnread, type ReadState } from "./readState.ts";
import { isWakeForOthers } from "./wakeMessage.ts";

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
 * Window size for a channel with NO read marker (`since: 0`, never read).
 * Its whole history is "unread", and the badge caps at 99+ anyway, so
 * UNREAD_COUNT_CAP + 1 messages is all the display can use — fetching 200
 * per never-read channel on every (re)subscribe was pure transfer cost
 * (background-sync plan §4.1 item 0.3).
 */
export const UNREAD_COUNT_NEVER_READ_LIMIT = 100;

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
  /**
   * The message's event id — a toast's Reply and Feedback name it.
   * Optional: samples built before it existed, and synthetic ones, have none.
   */
  eventId?: string;
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
 *   each channel's read marker. A channel with no marker gets
 *   UNREAD_COUNT_NEVER_READ_LIMIT (the display cap + 1) instead.
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
              limit:
                readMarkers[id] == null
                  ? UNREAD_COUNT_NEVER_READ_LIMIT
                  : UNREAD_COUNT_SAMPLE_LIMIT,
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
    eventId: event.id,
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
  /**
   * null = sampling mode: newest-message samples, no counts. Otherwise a
   * GETTER for the current read markers, read at every count decision — so
   * a marker move takes effect without re-creating the handlers (and
   * without re-REQing every channel's window; see useChannelActivity).
   */
  readMarkers: (() => ReadState) | null;
  selfPubkey: string | null;
  /**
   * Warm tap (background-sync plan §4.2): every raw kind-9 event this feed
   * receives, before any sample/count filtering, so the shared timeline
   * store can hold the message before the user opens its channel. Optional
   * — the feed's own semantics never depend on it.
   */
  onRawEvent?: (event: SignedNostrEvent) => void;
}

/** The SubscribeOptions-shaped pair the relay session calls into. */
export interface ChannelActivitySubscriptionHandlers {
  onEvent: (event: SignedNostrEvent) => void;
  onEose: () => void;
  /**
   * Re-derive these channels' counts from every event this subscription has
   * seen, against the CURRENT markers. Called after a marker moves forward:
   * the marker can land mid-window (read state synced from another device
   * while newer messages had already arrived), so forcing 0 would hide real
   * unread messages until some later re-subscribe. Channels this batch has
   * seen nothing for are left untouched.
   */
  recount: (channelIds: readonly string[]) => void;
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
 * A marker change does NOT re-create these handlers or re-REQ the window:
 * the owning hook zeroes the moved channel's count, and every later count
 * decision reads the current marker through the `readMarkers` getter, so
 * arrivals at-or-below the new marker never count (see useChannelActivity).
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
    onRawEvent,
  } = deps;
  const markerFor = (channelId: string): number =>
    readMarkers?.()[channelId] ?? 0;
  let window: Map<string, UnreadCountEvent[]> | null = readMarkers
    ? new Map()
    : null;
  let backfillClosed = false;
  // Every distinct event seen per channel (by id, so replay rounds cannot
  // double it), bounded to the newest UNREAD_COUNT_BUFFER_MAX. Only the
  // marker-move recount reads it; counting otherwise follows the
  // backfill/live rules above.
  const seen: Map<string, Map<string, UnreadCountEvent>> | null = readMarkers
    ? new Map()
    : null;
  const remember = (id: string, entry: ChannelActivity): void => {
    if (!seen) {
      return;
    }
    let events = seen.get(entry.channelId);
    if (!events) {
      events = new Map();
      seen.set(entry.channelId, events);
    }
    events.set(id, { pubkey: entry.pubkey, createdAt: entry.createdAt });
    if (events.size > UNREAD_COUNT_BUFFER_MAX) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [eventId, sample] of events) {
        if (sample.createdAt < oldestAt) {
          oldestAt = sample.createdAt;
          oldestId = eventId;
        }
      }
      if (oldestId !== null) {
        events.delete(oldestId);
      }
    }
  };

  // Newest silent wake seen per channel. It never becomes the sample (so it
  // cannot dot, count or reorder), but it proves the channel had traffic up
  // to that instant — a baseline for the live-arrival decision in onEvent.
  const silentWakeFloor = new Map<string, number>();
  const noteSilentWake = (event: SignedNostrEvent): void => {
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (typeof channelId !== "string" || channelId.length === 0) {
      return;
    }
    const known = silentWakeFloor.get(channelId);
    if (known === undefined || event.created_at > known) {
      silentWakeFloor.set(channelId, event.created_at);
    }
  };

  return {
    recount(channelIds: readonly string[]): void {
      if (!seen) {
        return;
      }
      const targets = channelIds.filter((id) => seen.has(id));
      if (targets.length === 0) {
        return;
      }
      onUnreadCountsChange((previous) => {
        const next = new Map(previous);
        for (const channelId of targets) {
          next.set(
            channelId,
            countUnreadFromEvents(
              Array.from(seen.get(channelId)?.values() ?? []),
              markerFor(channelId),
              selfPubkey,
            ),
          );
        }
        return next;
      });
    },
    onEvent(event: SignedNostrEvent): void {
      // Every delivered kind-9 — including replays and at-or-below-sample
      // arrivals the sample map drops below — is a message the timeline
      // store may not have yet; the store's own rules decide what sticks.
      if (event.kind === 9) {
        onRawEvent?.(event);
      }
      // A scheduled wake addressed to another member is machinery the viewer
      // is a bystander to: the timeline keeps the row (tapped above), but it
      // must not become the channel's sample, a counted unread or a live
      // arrival — so no badge, dot, sidebar reorder or toast. Gated BEFORE
      // remember() so the marker-move recount cannot resurrect it either.
      if (isWakeForOthers(event, selfPubkey)) {
        noteSilentWake(event);
        return;
      }
      const entry = channelActivityFromEvent(event);
      if (!entry) {
        return;
      }
      remember(event.id, entry);
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
      // A message is a live arrival when it beats a known sample — or, in a
      // channel whose only delivered traffic so far was a silent wake, when
      // it is newer than that wake. Without the second arm a channel read up
      // to a wake (or a limit-1 DM sample that IS a wake) has no baseline,
      // and the woken agent's reply would arrive unseen: no count, no toast.
      const wakeFloor = silentWakeFloor.get(entry.channelId);
      const isLiveArrival =
        previous !== undefined ||
        (wakeFloor !== undefined && entry.createdAt > wakeFloor);
      if (isLiveArrival) {
        if (readMarkers) {
          // Live increment, same exclusion rules as the derivation.
          onUnreadCountsChange((counts) => {
            const next = new Map(counts);
            next.set(
              entry.channelId,
              incrementUnreadCount(
                counts.get(entry.channelId),
                entry,
                markerFor(entry.channelId),
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
            countUnreadFromEvents(samples, markerFor(channelId), selfPubkey),
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

/**
 * Strip markdown to a one-line preview (mirrors the DM sampler). Structural
 * lines — a table's `|---|` separator, fences — are dropped whole
 * (`shared/lib/plainText.ts`), so a toast never quotes raw table syntax.
 */
function plainPreview(content: string): string {
  return plainText(content, { embed: "📷 image" })
    .replace(/[#~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHANNEL_ACTIVITY_PREVIEW_MAX);
}
