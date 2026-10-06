import { type Dispatch, type SetStateAction, useEffect } from "react";
import {
  markSeen,
  type ReadState,
  saveReadState,
} from "@/features/channels/lib/readState.ts";
import { notifyReadStateLocalChange } from "@/features/channels/lib/readStateSync.ts";
import { usePageAttended } from "./pageAttention.ts";
import { type MarkerSource, traceUnread } from "./unreadTrace.ts";

/**
 * Advance one read marker held in React state: persist, schedule the NIP-RS
 * publish and record the move (with who made it) in the unread trace.
 */
export function markReadStateSeen(
  setReadState: Dispatch<SetStateAction<ReadState>>,
  channelId: string,
  createdAt: number,
  source: MarkerSource,
): void {
  setReadState((previous) => {
    const next = markSeen(previous, channelId, createdAt);
    if (next !== previous) {
      saveReadState(next);
      notifyReadStateLocalChange();
      traceUnread({
        type: "markerMoved",
        id: channelId,
        from: previous[channelId] ?? null,
        to: createdAt,
        source,
      });
    }
    return next;
  });
}

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
