import * as React from "react";

import { useAppShell } from "@/app/AppShellContext";
import { isThreadReply } from "@/features/messages/lib/threading";
import type { FeedItem } from "@/shared/api/types";
import { isReadAttended, useReadAttention } from "@/shared/lib/readAttention";

/**
 * Inbox overrides for top-level rows are consumed by opening the channel.
 * Thread-reply overrides intentionally remain until their thread is read.
 */
export function getTopLevelInboxUnreadOverrideIds(
  items: FeedItem[],
  channelId: string,
): string[] {
  return items.flatMap((item) =>
    item.channelId === channelId && !isThreadReply(item.tags) ? [item.id] : [],
  );
}

export function useChannelOpenReadState(
  activeChannelId: string | null,
  isChannelMember: boolean | undefined,
  activeReadAt: string | null,
) {
  const { feedItemState, locallyUnreadFeedItems, markChannelRead } =
    useAppShell();
  // I3: an open conversation is marked read only while the window is visible
  // and focused. Arrivals while nobody is looking stay unread (locally and on
  // every NIP-RS-synced device) until attention returns and this re-runs.
  const attended = useReadAttention();

  React.useEffect(() => {
    if (!activeChannelId || isChannelMember === false) return;
    if (!attended || !isReadAttended()) return;
    for (const itemId of getTopLevelInboxUnreadOverrideIds(
      locallyUnreadFeedItems,
      activeChannelId,
    )) {
      feedItemState.undoUnread(itemId);
    }
    markChannelRead(activeChannelId, activeReadAt, { topLevelOnly: true });
  }, [
    activeChannelId,
    activeReadAt,
    attended,
    feedItemState.undoUnread,
    isChannelMember,
    locallyUnreadFeedItems,
    markChannelRead,
  ]);
}
