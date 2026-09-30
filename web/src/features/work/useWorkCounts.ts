import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";

import {
  type ChannelMarkers,
  channelMarkers,
  markersKey,
} from "./lib/channelMarkers.ts";
import { useNowSeconds, useWorkFeed } from "./useWorkFeed.ts";

export interface WorkCounts {
  needs: number;
  running: number;
  /** Per-channel needs / running, for the sidebar's row markers. */
  markers: ChannelMarkers;
}

const NO_MARKERS: ChannelMarkers = new Map();
const ZERO: WorkCounts = { needs: 0, running: 0, markers: NO_MARKERS };
const WorkCountsContext = createContext<WorkCounts>(ZERO);

/**
 * The numbers the shell's chrome shows outside the Work tab: the sidebar's
 * Work row and channel markers, the phone tab bar's badge, the collapsed rail
 * and the Work tab's own label. Always Everywhere — a badge scoped to the
 * open channel would change as you navigate, which is not what a badge is
 * for.
 *
 * Computed ONCE, here, and handed down as a value that only changes when a
 * number does. The feed re-derives on every observer frame (a busy agent
 * emits several a second); had the sidebar read the feed itself it would
 * re-render — and re-rank its sections — at that rate. The marker map is
 * keyed by its content for the same reason.
 */
export function WorkCountsProvider({ children }: { children: ReactNode }) {
  const nowS = useNowSeconds(30_000);
  const feed = useWorkFeed({ scope: "everywhere", channelId: null, nowS });
  const needs = feed.needCounts.all;
  const running = feed.running.length;
  const live = channelMarkers(feed);
  const key = markersKey(live);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the map's content identity; `live` is rebuilt every render
  const markers = useMemo(() => live, [key]);
  const value = useMemo(
    () => ({ needs, running, markers }),
    [needs, running, markers],
  );
  return createElement(WorkCountsContext.Provider, { value }, children);
}

export function useWorkCounts(): WorkCounts {
  return useContext(WorkCountsContext);
}
