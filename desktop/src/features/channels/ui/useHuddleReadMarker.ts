import * as React from "react";

import { getThreadReference } from "@/features/messages/lib/threading";
import type { RelayEvent } from "@/shared/api/types";
import { isReadAttended, useReadAttention } from "@/shared/lib/readAttention";

type MarkChannelRead = (
  channelId: string,
  readAt: string | null | undefined,
  options?: { topLevelOnly?: boolean },
) => void;

type HuddleReadMarkerOptions = {
  activeChannelId: string | null;
  activeChannelIsMember: boolean | undefined;
  isHuddleTranscript: boolean;
  markChannelRead: MarkChannelRead;
  messages: RelayEvent[] | undefined;
  resolvedMessages: RelayEvent[];
};

export function useHuddleReadMarker({
  activeChannelId,
  activeChannelIsMember,
  isHuddleTranscript,
  markChannelRead,
  messages,
  resolvedMessages,
}: HuddleReadMarkerOptions) {
  const latestActiveMessage = React.useMemo(() => {
    if (!messages) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (getThreadReference(messages[index].tags).parentId === null) {
        return messages[index];
      }
    }
    return null;
  }, [messages]);
  const activeReadAt = latestActiveMessage
    ? new Date(latestActiveMessage.created_at * 1_000).toISOString()
    : null;
  const latestHuddleTranscriptMessage = React.useMemo(
    () =>
      isHuddleTranscript
        ? resolvedMessages.reduce<RelayEvent | null>(
            (latest, message) =>
              latest === null || message.created_at > latest.created_at
                ? message
                : latest,
            null,
          )
        : null,
    [isHuddleTranscript, resolvedMessages],
  );
  const hasFlattenedHuddleReplies = React.useMemo(
    () =>
      isHuddleTranscript &&
      resolvedMessages.some(
        (message) => getThreadReference(message.tags).parentId !== null,
      ),
    [isHuddleTranscript, resolvedMessages],
  );
  const huddleReadAt = latestHuddleTranscriptMessage
    ? new Date(latestHuddleTranscriptMessage.created_at * 1_000).toISOString()
    : activeReadAt;
  const lastHuddleReadKeyRef = React.useRef<string | null>(null);
  // I3: same attention gate as useChannelOpenReadState.
  const attended = useReadAttention();

  React.useEffect(() => {
    if (!activeChannelId || activeChannelIsMember === false) return;
    if (!attended || !isReadAttended()) return;
    const huddleReadKey = hasFlattenedHuddleReplies
      ? `${activeChannelId}:${huddleReadAt}`
      : null;
    if (
      huddleReadKey !== null &&
      lastHuddleReadKeyRef.current === huddleReadKey
    ) {
      return;
    }
    markChannelRead(activeChannelId, huddleReadAt, {
      topLevelOnly: !hasFlattenedHuddleReplies,
    });
    lastHuddleReadKeyRef.current = huddleReadKey;
  }, [
    activeChannelId,
    activeChannelIsMember,
    attended,
    hasFlattenedHuddleReplies,
    huddleReadAt,
    markChannelRead,
  ]);
}
