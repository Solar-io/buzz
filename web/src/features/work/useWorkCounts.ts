import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";

import { useNowSeconds, useWorkFeed } from "./useWorkFeed.ts";

export interface WorkCounts {
  needs: number;
  running: number;
}

const ZERO: WorkCounts = { needs: 0, running: 0 };
const WorkCountsContext = createContext<WorkCounts>(ZERO);

/**
 * The two numbers the shell's chrome shows outside the Work tab: the sidebar's
 * Work row, the phone tab bar's badge, the collapsed rail and the Work tab's
 * own label. Always Everywhere — a badge scoped to the open channel would
 * change as you navigate, which is not what a badge is for.
 *
 * Computed ONCE, here, and handed down as a value that only changes when a
 * number does. The feed re-derives on every observer frame (a busy agent
 * emits several a second); had the sidebar read the feed itself it would
 * re-render — and re-rank its sections — at that rate.
 */
export function WorkCountsProvider({ children }: { children: ReactNode }) {
  const nowS = useNowSeconds(30_000);
  const feed = useWorkFeed({ scope: "everywhere", channelId: null, nowS });
  const needs = feed.needCounts.all;
  const running = feed.running.length;
  const value = useMemo(() => ({ needs, running }), [needs, running]);
  return createElement(WorkCountsContext.Provider, { value }, children);
}

export function useWorkCounts(): WorkCounts {
  return useContext(WorkCountsContext);
}
