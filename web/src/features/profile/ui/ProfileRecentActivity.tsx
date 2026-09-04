import { useEffect, useState } from "react";

import { MESSAGE_SEARCH_KINDS } from "@/features/channels/lib/messageBuffer";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { Skeleton } from "@/shared/ui/skeleton";

const RECENT_LIMIT = 5;

interface RecentMessage {
  id: string;
  channelId: string;
  createdAt: number;
  content: string;
}

/**
 * "What has this person been saying" — their newest messages the viewer can
 * read.
 *
 * This is an author-scoped REQ with **no `#h`**, which has a consequence worth
 * being explicit about: the relay registers any subscription whose filters all
 * lack `#h` as *global*, and `fan_out_scoped` never delivers channel-scoped
 * events to a global subscription. So this gets history and then goes quiet
 * forever. That is exactly right for a card the user opens, reads, and closes
 * — but it is why this is a one-shot list and not a live feed, and why nothing
 * here waits for updates that will not come.
 *
 * The relay still applies its own visibility rules to the results, so this can
 * only ever show messages the viewer was already entitled to read.
 */
export function ProfileRecentActivity({
  pubkey,
  channelName,
  onOpenMessage,
}: {
  pubkey: string;
  channelName: (channelId: string) => string;
  onOpenMessage?: (channelId: string, messageId: string) => void;
}) {
  const { session } = useRelaySession();
  const [messages, setMessages] = useState<RecentMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setMessages([]);
    setLoading(true);
    const collected: RecentMessage[] = [];
    return session.subscribe(
      {
        kinds: [...MESSAGE_SEARCH_KINDS],
        authors: [pubkey],
        limit: RECENT_LIMIT,
      },
      {
        onEvent: (event: SignedNostrEvent) => {
          const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
          if (!channelId || event.content.trim().length === 0) {
            return;
          }
          collected.push({
            id: event.id,
            channelId,
            createdAt: event.created_at,
            content: event.content,
          });
          setMessages(
            [...collected]
              .sort((left, right) => right.createdAt - left.createdAt)
              .slice(0, RECENT_LIMIT),
          );
        },
        onEose: () => setLoading(false),
      },
    );
  }, [session, pubkey]);

  if (loading && messages.length === 0) {
    return (
      <div className="space-y-2" data-testid="profile-activity-loading">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="profile-activity-empty"
      >
        Nothing you can read from this person yet.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5" data-testid="profile-activity">
      {messages.map((message) => {
        const channel = channelName(message.channelId);
        const body = (
          <>
            <span className="flex items-baseline gap-2">
              {channel ? (
                <span className="truncate text-2xs text-muted-foreground">
                  #{channel}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground/70">
                {new Date(message.createdAt * 1000).toLocaleDateString()}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs">
              {message.content.replace(/\s+/g, " ").trim()}
            </span>
          </>
        );
        return (
          <li key={message.id}>
            {onOpenMessage ? (
              <button
                className="w-full rounded-md px-2 py-1 text-left hover:bg-accent/50"
                onClick={() => onOpenMessage(message.channelId, message.id)}
                type="button"
              >
                {body}
              </button>
            ) : (
              <span className="block px-2 py-1">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
