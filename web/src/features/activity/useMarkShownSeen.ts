import { useEffect } from "react";
import { usePageAttended } from "./pageAttention.ts";

/**
 * Mark the open conversation seen up to its newest message — but only while
 * it is actually in front of the person (invariant I3): the conversation is
 * the pane on screen (no web view or other page covering it), the tab is
 * visible and the window has focus. A conversation that arrives while any
 * of those is false stays unread until all three hold again, at which point
 * this re-runs and marks it.
 *
 * Extracted from repos.tsx, which used to mark on every arrival with no
 * gate at all (LEFT_NAV_ARCHITECTURE_REVIEW.md, cause A).
 */
export function useMarkShownSeen({
  channelId,
  newestMessageAt,
  shown,
  markSeen,
}: {
  /** The open conversation; "" when none. */
  channelId: string;
  /** created_at of its newest loaded message; 0 before the first one. */
  newestMessageAt: number;
  /** The conversation pane is the one on screen (nothing covers it). */
  shown: boolean;
  /** Advance the marker (stable identity, or the effect re-runs). */
  markSeen: (channelId: string, createdAt: number) => void;
}): void {
  const attended = usePageAttended();
  useEffect(() => {
    if (!shown || !attended || channelId === "" || newestMessageAt === 0) {
      return;
    }
    markSeen(channelId, newestMessageAt);
  }, [channelId, newestMessageAt, shown, attended, markSeen]);
}
