import type { Profile } from "@/features/channels/hooks";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { cn } from "@/shared/lib/cn";
import type { InboxFilter } from "../lib/inboxFilter.ts";
import type { InboxItem } from "../lib/inboxItem.ts";
import { InboxDetailPane } from "./InboxDetailPane.tsx";
import { InboxListPane } from "./InboxListPane.tsx";

/**
 * The home screen: an unread inbox on the left, the selected conversation in
 * context on the right.
 *
 * Deliberately prop-driven and free of hooks. Every relay subscription and
 * every piece of persisted state is the connector's job
 * (`HomeInboxRoute.tsx`), which makes this component renderable from a test
 * or a fixture harness without a relay — the only way to check that the
 * screen actually mounts and reacts, rather than that it compiles.
 */
export function HomeInbox({
  items,
  profiles,
  filter,
  counts,
  loading,
  selectedItem,
  context,
  selfPubkey,
  isRead,
  onFilterChange,
  onSelect,
  onClearSelection,
  onMarkRead,
  onMarkUnread,
  onOpenInChannel,
}: {
  items: InboxItem[];
  profiles: Map<string, Profile>;
  filter: InboxFilter;
  counts: Record<InboxFilter, number>;
  loading: boolean;
  selectedItem: InboxItem | null;
  context: TimelineMessage[];
  selfPubkey: string | null;
  isRead: (message: TimelineMessage) => boolean;
  onFilterChange: (filter: InboxFilter) => void;
  onSelect: (item: InboxItem) => void;
  onClearSelection: () => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onOpenInChannel: (item: InboxItem) => void;
}) {
  const hasSelection = selectedItem !== null;
  return (
    <div
      data-testid="home-inbox"
      className="flex min-h-0 flex-1 bg-background text-foreground"
    >
      <InboxListPane
        items={items}
        profiles={profiles}
        filter={filter}
        counts={counts}
        loading={loading}
        selectedConversationId={selectedItem?.conversationId ?? null}
        onFilterChange={onFilterChange}
        onSelect={onSelect}
        className={cn(
          "w-full shrink-0 md:w-88 md:border-r md:border-border",
          hasSelection && "hidden md:flex",
        )}
      />
      <InboxDetailPane
        item={selectedItem}
        context={context}
        profiles={profiles}
        selfPubkey={selfPubkey}
        isRead={isRead}
        onMarkRead={onMarkRead}
        onMarkUnread={onMarkUnread}
        onOpenInChannel={onOpenInChannel}
        onBack={onClearSelection}
        className={cn("min-w-0 flex-1", !hasSelection && "hidden md:flex")}
      />
    </div>
  );
}
