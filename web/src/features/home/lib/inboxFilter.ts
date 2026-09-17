/**
 * Inbox filters. Deliberately five, not the desktop's eight: the web client
 * has no reminders, drafts, project inbox or owned-agent registry to filter
 * on, and a menu of options that can never match anything is worse than a
 * short one. "asks" is the D-035 follow-on: decision cards addressed to the
 * viewer that their answer has not cleared yet.
 */

import type { AskItem } from "./askDetection.ts";
import type { InboxItem } from "./inboxItem.ts";

export type InboxFilter = "all" | "unread" | "asks" | "mention" | "dm";

export interface InboxFilterOption {
  value: InboxFilter;
  label: string;
}

export const INBOX_FILTER_OPTIONS: readonly InboxFilterOption[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "asks", label: "Asks" },
  { value: "mention", label: "Mentions" },
  { value: "dm", label: "DMs" },
];

/**
 * One row of the inbox list: a conversation or an ask, interleaved and sorted
 * together ({@link inboxRowSortAt} is the shared sort key). The ask arm
 * carries its display label because the caller has already resolved the
 * channel's display name (DMs are named by participant, not "DM").
 */
export type InboxListRow =
  | { kind: "conversation"; item: InboxItem }
  | { kind: "ask"; ask: AskItem; channelLabel: string };

/** Newest-activity timestamp for one row — the interleaved sort key. */
export function inboxRowSortAt(row: InboxListRow): number {
  return row.kind === "ask" ? row.ask.createdAt : row.item.latestActivityAt;
}

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
    case "asks":
      // A conversation is never an ask row; the ask list is a separate arm.
      return false;
    default:
      return item.categories.includes(filter);
  }
}

/**
 * Do ASK rows show under this filter? The list only ever holds unanswered
 * asks, so an ask counts as unread; "asks" is its dedicated filter, and
 * "mention"/"dm" remain conversation categories (a DM ask is still surfaced
 * under All/Asks/Unread — the ask is the unit, not the channel).
 */
export function matchesAskFilter(filter: InboxFilter): boolean {
  return filter === "all" || filter === "asks" || filter === "unread";
}

export function matchesRowFilter(
  row: InboxListRow,
  filter: InboxFilter,
): boolean {
  return row.kind === "ask"
    ? matchesAskFilter(filter)
    : matchesInboxFilter(row.item, filter);
}

export function filterInboxItems(
  items: readonly InboxItem[],
  filter: InboxFilter,
): InboxItem[] {
  return items.filter((item) => matchesInboxFilter(item, filter));
}

export function filterInboxRows(
  rows: readonly InboxListRow[],
  filter: InboxFilter,
): InboxListRow[] {
  return rows.filter((row) => matchesRowFilter(row, filter));
}

/** Row counts per filter, for the menu's trailing numbers. */
export function inboxFilterCounts(
  rows: readonly InboxListRow[],
): Record<InboxFilter, number> {
  return {
    all: rows.length,
    unread: rows.filter((row) => matchesRowFilter(row, "unread")).length,
    asks: rows.filter((row) => matchesRowFilter(row, "asks")).length,
    mention: rows.filter((row) => matchesRowFilter(row, "mention")).length,
    dm: rows.filter((row) => matchesRowFilter(row, "dm")).length,
  };
}
