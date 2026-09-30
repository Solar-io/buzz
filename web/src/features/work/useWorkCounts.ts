import { useNowSeconds, useWorkFeed } from "./useWorkFeed.ts";

/**
 * The two numbers the shell's chrome shows outside the Work tab: the sidebar's
 * Work row, the phone tab bar's badge, the collapsed rail and the Work tab's
 * own label. Always Everywhere — a badge scoped to the open channel would
 * change as you navigate, which is not what a badge is for.
 */
export function useWorkCounts(): { needs: number; running: number } {
  const nowS = useNowSeconds(30_000);
  const feed = useWorkFeed({ scope: "everywhere", channelId: null, nowS });
  return { needs: feed.needCounts.all, running: feed.running.length };
}
