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
 * Counting-mode inputs. A marker move zeroes that channel's count without
 * re-REQing; identity landing (selfPubkey) re-subscribes and re-derives.
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
 * NOT when a read marker moves. In counting mode the per-channel windows open
 * at `{since: marker, limit}` as of subscribe time; a marker move only zeroes
 * the moved channel's count, and every later count decision reads the
 * current marker through a getter (background-sync plan §4.1 item 0.3: the
 * old per-move re-REQ of every channel cost ~1.1 MB per channel switch).
 *
 * Counting (sidebar feed): event/EOSE handling lives in
 * createChannelActivityHandlers (channelActivity.ts) — the backfill window
 * derives counts at the subscription's first EOSE, live strictly-newer
 * foreign arrivals increment after that, and reconnect replays stay
 * exactly-once through the newest-wins sample map. Sampling (toast-only
 * feeds, no `counting` argument): limit:1 filters, no count state.
 *
 * Samples reset only when the feed's own identity changes (session or id
 * set); preserved samples also shield replayed backfill from the
 * live-arrival path, exactly as they do across reconnects.
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
  const isCounting = readMarkers !== null;
  // The handlers read markers through this ref (a getter), never a closure:
  // a marker move must not re-create them, or re-REQ anything.
  const readMarkersRef = useRef<ReadState | null>(readMarkers);
  readMarkersRef.current = readMarkers;

  // Marker map restricted to the subscribed ids, as a string: unrelated
  // channels' markers must not trigger the zeroing pass.
  const markersKey = useMemo(() => {
    if (!readMarkers) {
      return "";
    }
    const ids = idsKey ? idsKey.split(",") : [];
    return ids.map((id) => `${id}:${readMarkers[id] ?? 0}`).join(",");
  }, [idsKey, readMarkers]);

  // Marker-move zeroing (counting mode): opening a channel must clear its
  // badge NOW. Only channels whose marker advanced are zeroed. This is the
  // whole reaction to a marker move — the windows are NOT re-opened (that
  // re-REQ of every channel on every switch was ~1.1 MB per click, plan
  // §2 scenario B); later arrivals at-or-below the new marker never count
  // because the handlers read the current marker via readMarkersRef.
  // biome-ignore lint/correctness/useExhaustiveDependencies: markersKey is the trigger; the body reads the ref, which is current by construction
  useEffect(() => {
    const markers = readMarkersRef.current;
    if (!markers) {
      prevMarkersRef.current = null;
      return;
    }
    const previousMarkers = prevMarkersRef.current;
    if (previousMarkers) {
      setUnreadCounts((previous) =>
        resetCountsForMarkerChanges(previous, previousMarkers, markers),
      );
    }
    prevMarkersRef.current = markers;
  }, [markersKey]);

  // Re-subscribes only when the feed's identity (session, id set), its mode
  // or the viewer changes — never on a marker move. The initial `since` is
  // the marker at subscribe time; a reconnect replays that same window,
  // bounded by the per-channel limit, and its re-delivered events are
  // deduped by the sample map.
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    // Reset the sample map only when the feed's identity changes.
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
    const fireLive = (entry: ChannelActivity) => {
      for (const handler of handlersRef.current) {
        handler(entry);
      }
    };
    const getMarkers = isCounting ? () => readMarkersRef.current ?? {} : null;
    const unsubscribes = channelActivityFilterBatches(
      ids,
      isCounting ? (readMarkersRef.current ?? {}) : undefined,
    ).map((filters) =>
      session.subscribe(
        filters,
        createChannelActivityHandlers({
          activityRef,
          onActivityChange: setActivity,
          onLiveArrival: fireLive,
          onUnreadCountsChange: setUnreadCounts,
          readMarkers: getMarkers,
          selfPubkey,
        }),
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, idsKey, isCounting, selfPubkey]);

  return { activity, unreadCounts, onLiveEvent };
}
