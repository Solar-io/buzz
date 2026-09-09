/**
 * Live channel activity feed, extracted from hooks.ts (file-size ceiling; the
 * useForum.ts precedent). Everything the sidebar's unread signals read:
 * newest-message samples plus, in counting mode, live unread counts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { ReadState } from "./lib/readState.ts";
import {
  channelActivityFilterBatches,
  createChannelActivityHandlers,
  resetCountsForMarkerChanges,
  type ChannelActivity,
  type ChannelActivityMap,
  type ChannelUnreadCounts,
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
 * Counting (sidebar feed): event/EOSE handling lives in
 * createChannelActivityHandlers (channelActivity.ts) — the backfill window
 * derives counts at the subscription's first EOSE, live strictly-newer
 * foreign arrivals increment after that, and reconnect replays stay
 * exactly-once through the newest-wins sample map. A channel whose marker
 * advanced is zeroed immediately, ahead of the re-REQ; its fresh handlers
 * re-enter backfill and re-derive at EOSE. Sampling (toast-only feeds, no
 * `counting` argument): limit:1 filters, no count state — identical to the
 * feed before counts existed.
 *
 * SAMPLES SURVIVE marker-only re-runs: every message arriving in the VIEWED
 * channel advances its marker and re-opens this feed, so wiping the sample
 * map there would blank every other row's unread dot until the re-REQ's
 * EOSE landed (a whole-sidebar flicker per arriving message on a busy
 * channel). Samples reset only when the feed's own identity changes
 * (session or id set); preserved samples also shield replayed backfill from
 * the live-arrival path, exactly as they do across reconnects.
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
  // The feed identity (session + id set) the previous run saw: samples reset
  // only when THIS changes, not on marker-only re-runs.
  const prevFeedRef = useRef<{ session: unknown; idsKey: string } | null>(null);

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

  const readMarkers = counting?.readMarkers ?? null;
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
    // Reset the sample map only when the feed's identity changes; a
    // marker-only re-run keeps every sample (see the doc comment above).
    const feedChanged =
      prevFeedRef.current?.session !== session ||
      prevFeedRef.current?.idsKey !== idsKey;
    prevFeedRef.current = { session, idsKey };
    if (feedChanged) {
      activityRef.current = new Map();
      setActivity(activityRef.current);
    }
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
    const fireLive = (entry: ChannelActivity) => {
      for (const handler of handlersRef.current) {
        handler(entry);
      }
    };
    const unsubscribes = channelActivityFilterBatches(
      ids,
      readMarkers ?? undefined,
    ).map((filters) =>
      session.subscribe(
        filters,
        createChannelActivityHandlers({
          activityRef,
          onActivityChange: setActivity,
          onLiveArrival: fireLive,
          onUnreadCountsChange: setUnreadCounts,
          readMarkers,
          selfPubkey,
        }),
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, idsKey, markersKey, readMarkers, selfPubkey]);

  return { activity, unreadCounts, onLiveEvent };
}
