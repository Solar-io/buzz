import { ArrowLeft, ArrowUpRight, Check, Inbox, Undo2 } from "lucide-react";

import type { Profile } from "@/features/channels/hooks";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { MessageRow } from "@/features/channels/ui/MessageRow";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { inboxItemChannelLabel, type InboxItem } from "../lib/inboxItem.ts";
import { inboxContextGrouped } from "../lib/inboxThread.ts";

/** Empty state: no row picked yet. */
function NothingSelected() {
  return (
    <div
      data-testid="inbox-detail-empty"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <Inbox aria-hidden className="h-8 w-8 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">
        Select a conversation to read it in context.
      </p>
    </div>
  );
}

/**
 * The selected conversation, rendered as a timeline.
 *
 * This is where `MessageRow` fits without argument: the pane wants exactly
 * what a channel wants — grouped author headers, markdown, media, reactions
 * and the hover action bar — so it reuses the channel's row rather than
 * growing a second message renderer. The list pane does not, and says why.
 */
export function InboxDetailPane({
  item,
  context,
  profiles,
  selfPubkey,
  isRead,
  onMarkRead,
  onMarkUnread,
  onOpenInChannel,
  onBack,
  className,
}: {
  item: InboxItem | null;
  /** Surrounding conversation, oldest first (see `lib/inboxThread.ts`). */
  context: TimelineMessage[];
  profiles: Map<string, Profile>;
  selfPubkey: string | null;
  /** Read predicate, so the pane can mark the boundary the list agreed on. */
  isRead: (message: TimelineMessage) => boolean;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  /** Hand off to the full channel view. */
  onOpenInChannel: (item: InboxItem) => void;
  /** Clear the selection — the narrow-viewport back affordance. */
  onBack: () => void;
  className?: string;
}) {
  if (!item) {
    return (
      <div className={cn("flex min-h-0 flex-col", className)}>
        <NothingSelected />
      </div>
    );
  }

  const firstUnreadId = context.find((message) => !isRead(message))?.id ?? null;

  return (
    <div
      data-testid="inbox-detail-pane"
      className={cn("flex min-h-0 flex-col", className)}
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          data-testid="inbox-detail-back"
          aria-label="Back to inbox"
          onClick={onBack}
          className="-ml-2 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/70 hover:text-foreground md:hidden"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <h2
            data-testid="inbox-detail-title"
            className="truncate text-sm font-semibold"
          >
            {inboxItemChannelLabel(item)}
          </h2>
          <p className="truncate text-2xs text-muted-foreground">
            {item.channelType === "dm" ? "Direct message" : "Thread"} ·{" "}
            {context.length} {context.length === 1 ? "message" : "messages"}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {item.unreadCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="inbox-mark-read"
              onClick={onMarkRead}
            >
              <Check aria-hidden />
              Mark read
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="inbox-mark-unread"
              onClick={onMarkUnread}
            >
              <Undo2 aria-hidden />
              Mark unread
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="inbox-open-channel"
            onClick={() => onOpenInChannel(item)}
          >
            Open
            <ArrowUpRight aria-hidden />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {context.map((message, index) => (
          <div key={message.id}>
            {message.id === firstUnreadId && index > 0 && (
              <div
                data-testid="inbox-unread-divider"
                className="my-3 flex items-center gap-2 px-2"
              >
                <span className="h-px flex-1 bg-primary/40" />
                <span className="text-2xs font-medium uppercase tracking-wide text-primary">
                  New
                </span>
                <span className="h-px flex-1 bg-primary/40" />
              </div>
            )}
            <MessageRow
              message={message}
              profiles={profiles}
              grouped={
                message.id !== firstUnreadId &&
                inboxContextGrouped(message, context[index - 1])
              }
              replyCount={0}
              onOpenThread={() => onOpenInChannel(item)}
              active={message.id === item.message.id}
              reactionGroups={[]}
              selfPubkey={selfPubkey}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
