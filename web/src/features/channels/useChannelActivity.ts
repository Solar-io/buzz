/**
 * Live channel activity feed, extracted from hooks.ts (file-size ceiling; the
 * useForum.ts precedent). Everything the sidebar's unread signals read:
 * newest-message samples plus, in counting mode, live unread counts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { ReadState } from "./lib/readState.ts";
import {
  UNREAD_COUNT_BUFFER_MAX,
  applyChannelActivity,
  channelActivityFilterBatches,
  channelActivityFromEvent,
  countUnreadFromEvents,
  incrementUnreadCount,
  resetCountsForMarkerChanges,
  type ChannelActivity,
  type ChannelActivityMap,
  type ChannelUnreadCounts,
  type UnreadCountEvent,
} from "./lib/channelActivity.ts";

/** A live arrival from {@link useChannelActivity}'s feed. */
export type ChannelActivityEvent = ChannelActivity;

export interface UseChannelActivityResult {
  /** Newest sampled message per channel id (stable ref until content changes). */
  activity: ChannelActivityMap;
  /**
   * Live unread count per channel id, counting mode only. Present (0) once
   * the channel's window has been derived; absent until then, which rows
   * render as the metadata-fallback dot.
   */
  unreadCounts: ChannelUnreadCounts;
  /**
   * Register a handler for LIVE arrivals only — messages that beat a
   * previously sampled entry for their channel. Returns an unregister fn.
   */
  onLiveEvent: (handler: (entry: ChannelActivityEvent) => void) => () => void;
}

/**
 * Counting-mode inputs: the feed re-REQs whenever a subscribed channel's read
 * marker moves (or identity lands), so counts stay honest across sessions.
 */
export interface ChannelActivityCounting {
  /** Per-channel read markers (localStorage read state). */
  readMarkers: ReadState;
  /**
   * Viewer's key. null (locked) counts every arrival — a transient
   * over-count until identity lands and the feed re-derives.
   */
  selfPubkey: string | null;
}

/**
 * Newest-message feed across a set of channel ids: batched kind:9
 * subscriptions, one entry per channel, newest-wins, kept live for the
 * session. This is the feed the sidebar's unread signals read and the
 * message toasts toast from; DM rows keep their own feed (useDms).
 *
 * Resubscribes only when the id SET changes (joined key), like the DM hook —
 * plus, in counting mode, when a subscribed channel's read marker changes:
 * the per-channel windows are `{since: marker, limit: 200}` (the DM
 * unread-count hook's bounded shape), so a marker move must re-open them at
 * the new `since` or the counts would keep growing against a stale marker.
 *
 * Counting (sidebar feed): counts are DERIVED at EOSE from the events each
 * subscription buffered since its markers (idempotent across reconnect
 * replays, which re-REQ and re-EOSE), then incremented by live strictly-newer
 * foreign arrivals riding the same newest-wins guard the toast handlers use.
 * A channel whose marker advanced is zeroed immediately, ahead of the re-REQ.
 * Sampling (toast-only feeds, no `counting` argument): limit:1 filters, no
 * count state — identical to the feed before counts existed.
 */
export function useChannelActivity(
  channelIds: string[],
  counting?: ChannelActivityCounting,
): UseChannelActivityResult {
  const { session } = useRelaySession();
  const [activity, setActivity] = useState<ChannelActivityMap>(() => new Map());
  const [unreadCounts, setUnreadCounts] = useState<ChannelUnreadCounts>(
    () => new Map(),
  );
  // Mirror of state the event handler reads synchronously: the decision
  // "strictly newer than the stored sample" must not go through React's
  // async commit, or two quick arrivals could both read as live.
  const activityRef = useRef<ChannelActivityMap>(activity);
  const handlersRef = useRef(new Set<(entry: ChannelActivityEvent) => void>());
  // Markers the previous effect run saw, for the marker-move zeroing diff.
  const prevMarkersRef = useRef<ReadState | null>(null);

  const onLiveEvent = useCallback(
    (handler: (entry: ChannelActivityEvent) => void) => {
      handlersRef.current.add(handler);
      return () => {
        handlersRef.current.delete(handler);
      };
    },
    [],
  );

  // Ids are UUIDs, so a sorted joined string is a lossless set key.
  const idsKey = useMemo(
    () => Array.from(new Set(channelIds)).sort().join(","),
    [channelIds],
  );

  const readMarkers = counting?.readMarkers;
  const selfPubkey = counting?.selfPubkey ?? null;

  // Marker map restricted to the subscribed ids, as a string: unrelated
  // channels' markers must not re-open the feed, and a stable string keeps
  // the effect key referentially sound.
  const markersKey = useMemo(() => {
    if (!readMarkers) {
      return "";
    }
    const ids = idsKey ? idsKey.split(",") : [];
    return ids.map((id) => `${id}:${readMarkers[id] ?? 0}`).join(",");
  }, [idsKey, readMarkers]);

  // markersKey is a dep by design: it is the re-subscription gate (a marker
  // move re-opens the windows at the new `since`) while readMarkers — the
  // object the body reads — only re-runs this effect when a SUBSCRIBED
  // channel's marker moved, so opening a DM never re-REQs the channel feed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: markersKey gates re-subscription; removing it would key the effect on the raw object and re-REQ on unrelated marker changes
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    activityRef.current = new Map();
    setActivity(activityRef.current);
    if (ids.length === 0) {
      return;
    }
    // Marker-move zeroing (counting mode): opening a channel must clear its
    // badge NOW, not when the re-REQ's EOSE lands. Only channels whose
    // marker advanced are zeroed, so sibling badges survive the re-REQ.
    if (readMarkers) {
      const previousMarkers = prevMarkersRef.current;
      if (previousMarkers) {
        setUnreadCounts((previous) =>
          resetCountsForMarkerChanges(previous, previousMarkers, readMarkers),
        );
      }
      prevMarkersRef.current = readMarkers;
    }
    const unsubscribes = channelActivityFilterBatches(ids, readMarkers).map(
      (filters) => {
        // Counting state for THIS subscription: the sampled window since each
        // channel's marker. Events buffer here until EOSE derives counts from
        // them; reconnects replay the REQ and re-deliver the window, so the
        // buffer stays bounded and the EOSE re-derivation stays idempotent.
        const window = new Map<string, UnreadCountEvent[]>();
        return session.subscribe(filters, {
          onEvent: (event: SignedNostrEvent) => {
            const entry = channelActivityFromEvent(event);
            if (!entry) {
              return;
            }
            if (readMarkers) {
              const samples = window.get(entry.channelId) ?? [];
              samples.push(entry);
              window.set(
                entry.channelId,
                samples.slice(-UNREAD_COUNT_BUFFER_MAX),
              );
            }
            const previous = activityRef.current.get(entry.channelId);
            // Strictly newer wins: stale, duplicate and reconnect-replayed
            // events (same created_at as the stored sample) are dropped here.
            if (previous && previous.createdAt >= entry.createdAt) {
              return;
            }
            // Replay guard: a handler fires only when a KNOWN sample is beaten.
            // The FIRST sample per channel is the mount/reconnect backfill and
            // is never treated as a live arrival, so opening the app or the id
            // set changing never re-toasts history. Clock-skew note: created_at
            // is the PUBLISHER's clock, not ours — a publisher whose clock lags
            // its previous message can have a genuinely-new event land at or
            // below the stored sample and be silently suppressed (a missed
            // toast; a Date.now() gate would carry the same skew against a
            // different clock, on top of breaking on relays that replay in
            // order). Chosen because strictly-newer is already what the reducer
            // enforces, so the guard cannot disagree with the feed.
            if (previous) {
              if (readMarkers) {
                // Live increment, same exclusion rules as the derivation. A
                // backfill arrival that beats a surviving sample (out-of-order
                // replay) can transiently bump the count; the next EOSE
                // re-derives it from the buffered window and corrects it.
                setUnreadCounts((counts) => {
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
              for (const handler of handlersRef.current) {
                handler(entry);
              }
            }
            activityRef.current = applyChannelActivity(
              activityRef.current,
              entry,
            );
            setActivity(activityRef.current);
          },
          onEose: () => {
            if (!readMarkers) {
              return;
            }
            // Derive each channel's count from its buffered window — the
            // reconnect/re-REQ path too, which is what keeps replayed events
            // from double-counting: derivation REPLACES the incremented value.
            setUnreadCounts((previous) => {
              const next = new Map(previous);
              for (const [channelId, samples] of window) {
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
          },
        });
      },
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, idsKey, markersKey, readMarkers, selfPubkey]);

  return { activity, unreadCounts, onLiveEvent };
}
