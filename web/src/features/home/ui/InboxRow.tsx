import { AtSign, MessageSquare } from "lucide-react";

import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { formatTime } from "@/features/channels/lib/dateFormatters.ts";
import { replyExcerpt } from "@/features/channels/lib/replyExcerpt.ts";
import { cn } from "@/shared/lib/cn";
import { inboxItemChannelLabel, type InboxItem } from "../lib/inboxItem.ts";

/** One list row. Deliberately not `MessageRow`: see the note in InboxListPane. */
export function InboxRow({
  item,
  profiles,
  selected,
  onSelect,
}: {
  item: InboxItem;
  profiles: Map<string, Profile>;
  selected: boolean;
  onSelect: () => void;
}) {
  const unread = item.unreadCount > 0;
  const isDm = item.channelType === "dm";
  const label = authorLabel(item.message.authorPubkey, profiles);
  return (
    <button
      type="button"
      data-testid={`inbox-row-${item.conversationId}`}
      data-unread={unread ? "true" : "false"}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full gap-3 rounded-xl px-3 py-2 text-left transition-colors",
        "hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-muted/70 hover:bg-muted/70",
      )}
    >
      <div className="relative shrink-0 pt-0.5">
        <AuthorAvatar
          pubkey={item.message.authorPubkey}
          label={label}
          picture={profiles.get(item.message.authorPubkey)?.avatar}
          size="md-sm"
        />
        {unread && (
          <span
            data-testid="inbox-row-unread-dot"
            aria-hidden
            className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "truncate text-sm",
              unread ? "font-semibold text-foreground" : "text-foreground/90",
            )}
          >
            {label}
          </span>
          <span className="flex min-w-0 shrink items-center gap-1 text-2xs text-muted-foreground">
            {isDm ? (
              <MessageSquare aria-hidden className="h-3 w-3 shrink-0" />
            ) : (
              <AtSign aria-hidden className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">{inboxItemChannelLabel(item)}</span>
          </span>
          <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-2xs text-muted-foreground">
            {formatTime(item.latestActivityAt)}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 line-clamp-2 text-sm",
            unread ? "text-foreground/90" : "text-muted-foreground",
          )}
        >
          {replyExcerpt(item.message.content, 160) || "(no text)"}
        </p>
        {(item.unreadCount > 1 || item.messages.length > 1) && (
          <div className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground">
            {item.messages.length > 1 && (
              <span>{item.messages.length} messages</span>
            )}
            {item.unreadCount > 1 && (
              <span
                data-testid="inbox-row-unread-count"
                className="rounded-full bg-primary/15 px-1.5 font-medium text-primary"
              >
                {item.unreadCount} new
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
