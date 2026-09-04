import type { Profile } from "@/features/channels/hooks";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/shared/lib/cn";
import type { InboxFilter } from "../lib/inboxFilter.ts";
import type { InboxItem } from "../lib/inboxItem.ts";
import { InboxFilterMenu } from "./InboxFilterMenu.tsx";
import { InboxRow } from "./InboxRow.tsx";

/**
 * The inbox list.
 *
 * ## Why the rows are not `MessageRow`
 *
 * `features/channels/ui/MessageRow` renders a message the way a *timeline*
 * wants it: full markdown body, media, link previews, reaction chips and a
 * hover action bar, with the channel implied by the surrounding view. A list
 * row needs the opposite — a two-line excerpt, the channel stated explicitly
 * because every row is from a different one, an unread marker, and a grouped
 * count for the conversation behind it. Reusing MessageRow here would mean
 * threading half a dozen "…but not in the inbox" flags through it and would
 * make the list scroll a wall of rendered markdown.
 *
 * MessageRow IS reused where its shape actually fits: the detail pane, which
 * renders the conversation as a timeline. See `InboxDetailPane`.
 */
export function InboxListPane({
  items,
  profiles,
  filter,
  counts,
  loading,
  selectedConversationId,
  onFilterChange,
  onSelect,
  className,
}: {
  items: InboxItem[];
  profiles: Map<string, Profile>;
  filter: InboxFilter;
  counts: Record<InboxFilter, number>;
  loading: boolean;
  selectedConversationId: string | null;
  onFilterChange: (filter: InboxFilter) => void;
  onSelect: (item: InboxItem) => void;
  className?: string;
}) {
  return (
    <div
      data-testid="inbox-list-pane"
      className={cn("flex min-h-0 flex-col", className)}
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <InboxFilterMenu
          filter={filter}
          counts={counts}
          onFilterChange={onFilterChange}
        />
        <span
          data-testid="inbox-count"
          className="ml-auto tabular-nums text-2xs text-muted-foreground"
        >
          {items.length} {items.length === 1 ? "conversation" : "conversations"}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && items.length === 0 ? (
          <ul className="space-y-2" aria-hidden>
            {[0, 1, 2, 3].map((row) => (
              <li key={row} className="flex gap-3 px-3 py-2">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <p
            data-testid="inbox-empty"
            className="px-3 py-8 text-center text-sm text-muted-foreground"
          >
            {filter === "all"
              ? "Nothing addressed to you yet. Mentions and direct messages land here."
              : "Nothing matches this filter."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item.conversationId}>
                <InboxRow
                  item={item}
                  profiles={profiles}
                  selected={item.conversationId === selectedConversationId}
                  onSelect={() => onSelect(item)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
