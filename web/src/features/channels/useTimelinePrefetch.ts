import { useEffect, useMemo, useRef } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { ChannelActivityMap } from "./lib/channelActivity.ts";
import {
  createPrefetchBudget,
  PREFETCH_TOP_N,
  prefetchTimeline,
  selectPrefetchCandidates,
  type RecencySample,
} from "./lib/timelinePrefetch.ts";
import { timelineStore } from "./lib/timelineStore.ts";

/** Debounce after a top-N conversation receives activity. */
const ACTIVITY_DEBOUNCE_MS = 2_000;
/** requestIdleCallback fallback. */
const IDLE_FALLBACK_MS = 1_000;

/** One budget for the whole app session (≤ 12 prefetch REQs per minute). */
const budget = createPrefetchBudget();

function whenIdle(run: () => void): () => void {
  const w = globalThis as {
    requestIdleCallback?: (cb: () => void) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    const handle = w.requestIdleCallback(run);
    return () => w.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, IDLE_FALLBACK_MS);
  return () => clearTimeout(timer);
}

function saveDataOn(): boolean {
  const connection = (
    globalThis.navigator as { connection?: { saveData?: boolean } } | undefined
  )?.connection;
  return connection?.saveData === true;
}

/**
 * Idle-prefetch the conversations the user is most likely to open next, so
 * a switch paints from memory (background-sync plan §4.3). Runs after the
 * boot/reconnect replay drains, 2 s after a top-N conversation gets
 * activity, and when the page becomes visible again — always on idle, at
 * background priority (one REQ in flight), within a 12/min budget, and
 * never with Save-Data on or before the socket is authenticated.
 */
export function useTimelinePrefetch(input: {
  channelActivity: ChannelActivityMap;
  dms: ReadonlyArray<{ channel: { id: string }; lastActivity: number }>;
  openId: string | null;
}): void {
  const { session } = useRelaySession();
  const { channelActivity, dms, openId } = input;

  const samples = useMemo<RecencySample[]>(() => {
    const list: RecencySample[] = [];
    for (const [id, activity] of channelActivity) {
      list.push({ id, at: activity.createdAt });
    }
    // DMs ride the same activity feed now; a DM already sampled there must
    // not be listed twice.
    for (const dm of dms) {
      if (!channelActivity.has(dm.channel.id)) {
        list.push({ id: dm.channel.id, at: dm.lastActivity });
      }
    }
    return list;
  }, [channelActivity, dms]);

  const latest = useRef({ samples, openId });
  latest.current = { samples, openId };

  const runRef = useRef<() => void>(() => {});
  runRef.current = () => {
    if (saveDataOn() || !session.isReady) {
      return;
    }
    const { samples: current, openId: open } = latest.current;
    for (const id of selectPrefetchCandidates(current, timelineStore, open)) {
      if (!budget.take()) {
        return;
      }
      void prefetchTimeline(timelineStore, session, id);
    }
  };

  // After every (re)connect's replay drains, and whenever the page is
  // shown again.
  useEffect(() => {
    let cancelIdle: (() => void) | null = null;
    const schedule = () => {
      cancelIdle?.();
      cancelIdle = whenIdle(() => runRef.current());
    };
    const offDrained = session.onReplayDrained(schedule);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        schedule();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    if (session.isReady) {
      schedule();
    }
    return () => {
      offDrained();
      cancelIdle?.();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [session]);

  // Debounced re-run when the top-N set or its newest activity moves.
  const topKey = useMemo(
    () =>
      [...samples]
        .filter((sample) => sample.at > 0)
        .sort((a, b) => b.at - a.at)
        .slice(0, PREFETCH_TOP_N)
        .map((sample) => `${sample.id}:${sample.at}`)
        .join(","),
    [samples],
  );
  useEffect(() => {
    if (!topKey) {
      return;
    }
    let cancelIdle: (() => void) | null = null;
    const timer = setTimeout(() => {
      cancelIdle = whenIdle(() => runRef.current());
    }, ACTIVITY_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      cancelIdle?.();
    };
  }, [topKey]);
}
