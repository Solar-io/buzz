import { useEffect, useMemo, useState } from "react";

import {
  type TimelineMessage,
  timelineMessageFromEvent,
} from "@/features/channels/lib/messageBuffer.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { fileCommentsFilter } from "./lib/shelfQuery.ts";

/**
 * Comments on a file are thread replies to its share message (phase-6
 * "Comments"): one REQ per open file, scoped to the share's channel by `#h`
 * so replies arrive live, oldest first.
 *
 * `add` lets the comment box show its own send before the relay echoes it
 * (the echo upserts the same id).
 */
export function useFileComments(
  share: { id: string; channelId: string } | null,
): {
  comments: TimelineMessage[];
  loaded: boolean;
  add: (message: TimelineMessage) => void;
} {
  const { session, status } = useRelaySession();
  const [byId, setById] = useState<ReadonlyMap<string, TimelineMessage>>(
    () => new Map(),
  );
  const [loaded, setLoaded] = useState(false);
  const shareId = share?.id ?? null;
  const channelId = share?.channelId ?? null;

  useEffect(() => {
    setById(new Map());
    setLoaded(false);
    if (shareId === null || channelId === null || status === "idle") {
      return;
    }
    const unsubscribe = session.subscribe(
      fileCommentsFilter({ id: shareId, channelId }),
      {
        onEvent: (event) => {
          if (event.id === shareId) {
            return;
          }
          const message = timelineMessageFromEvent(event);
          if (!message) {
            return;
          }
          setById((previous) => {
            if (previous.has(message.id)) {
              return previous;
            }
            const next = new Map(previous);
            next.set(message.id, message);
            return next;
          });
        },
        onEose: () => setLoaded(true),
      },
    );
    const fallback = setTimeout(() => setLoaded(true), 8_000);
    return () => {
      clearTimeout(fallback);
      unsubscribe();
    };
  }, [session, status, shareId, channelId]);

  const comments = useMemo(
    () =>
      [...byId.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      ),
    [byId],
  );
  return {
    comments,
    loaded,
    add: (message) =>
      setById((previous) => {
        if (previous.has(message.id)) {
          return previous;
        }
        const next = new Map(previous);
        next.set(message.id, message);
        return next;
      }),
  };
}
