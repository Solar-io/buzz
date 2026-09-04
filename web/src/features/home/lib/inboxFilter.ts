/**
 * Inbox filters. Deliberately four, not the desktop's eight: the web client
 * has no reminders, drafts, project inbox or owned-agent registry to filter
 * on, and a menu of options that can never match anything is worse than a
 * short one.
 */

import type { InboxItem } from "./inboxItem.ts";

export type InboxFilter = "all" | "unread" | "mention" | "dm";

export interface InboxFilterOption {
  value: InboxFilter;
  label: string;
}

export const INBOX_FILTER_OPTIONS: readonly InboxFilterOption[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "mention", label: "Mentions" },
  { value: "dm", label: "DMs" },
];

export function inboxFilterLabel(filter: InboxFilter): string {
  return (
    INBOX_FILTER_OPTIONS.find((option) => option.value === filter)?.label ??
    "All"
  );
}

/** Coerce persisted/URL input to a known filter. */
export function parseInboxFilter(value: unknown): InboxFilter {
  return INBOX_FILTER_OPTIONS.some((option) => option.value === value)
    ? (value as InboxFilter)
    : "all";
}

export function matchesInboxFilter(
  item: Pick<InboxItem, "categories" | "unreadCount">,
  filter: InboxFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unread":
      return item.unreadCount > 0;
    default:
      return item.categories.includes(filter);
  }
}

export function filterInboxItems(
  items: readonly InboxItem[],
  filter: InboxFilter,
): InboxItem[] {
  return items.filter((item) => matchesInboxFilter(item, filter));
}

/** Row counts per filter, for the menu's trailing numbers. */
export function inboxFilterCounts(
  items: readonly InboxItem[],
): Record<InboxFilter, number> {
  return {
    all: items.length,
    unread: items.filter((item) => matchesInboxFilter(item, "unread")).length,
    mention: items.filter((item) => matchesInboxFilter(item, "mention")).length,
    dm: items.filter((item) => matchesInboxFilter(item, "dm")).length,
  };
}
