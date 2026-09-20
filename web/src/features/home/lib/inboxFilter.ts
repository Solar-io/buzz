/**
 * Inbox filters. Deliberately five, not the desktop's eight: the web client
 * has no reminders, drafts, project inbox or owned-agent registry to filter
 * on, and a menu of options that can never match anything is worse than a
 * short one. "asks" is the D-035 follow-on: decision cards addressed to the
 * viewer that their answer has not cleared yet.
 */

import type { AskItem } from "./askDetection.ts";
import type { AskInterview } from "./askInterview.ts";
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
 *
 * The ask arm is an INTERVIEW, not a card: an agent refines by sending a
 * second card in the same thread, and those are one thing waiting on the user
 * (`askInterview.ts`). `row.ask` is the interview's representative — the
 * newest card still open — so every rule below that reads a card still reads
 * the right one.
 */
export type InboxListRow =
  | { kind: "conversation"; item: InboxItem }
  | { kind: "ask"; interview: AskInterview; channelLabel: string };

/** The card an ask row is waiting on. */
export function askRowCard(
  row: Extract<InboxListRow, { kind: "ask" }>,
): AskItem {
  return row.interview.ask;
}

/** Newest-activity timestamp for one row — the interleaved sort key. */
export function inboxRowSortAt(row: InboxListRow): number {
  return row.kind === "ask"
    ? row.interview.ask.createdAt
    : row.item.latestActivityAt;
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
 * asks, so an ask counts as unread, and "asks" is its dedicated filter.
 * "dm"/"mention" classify an ask by WHERE it lives: a DM ask under "dm", a
 * channel ask under "mention" (a channel ask always carries the viewer's
 * p-tag — the mention is how it qualified as an ask).
 *
 * The earlier rule (asks only under All/Asks/Unread, never dm/mention) hid
 * the badge's own content from two of five tabs: with one unanswered DM ask
 * and the DMs filter active, the badge said 1 and no row anywhere showed it
 * (Sam, 2026-09-17 — "one unread item I can't find"). A filter must never
 * hide the exact rows the badge is counting.
 */
export function matchesAskFilter(
  filter: InboxFilter,
  channelType: AskItem["channelType"],
): boolean {
  switch (filter) {
    case "all":
    case "asks":
    case "unread":
      return true;
    case "dm":
      return channelType === "dm";
    default:
      return channelType !== "dm";
  }
}

export function matchesRowFilter(
  row: InboxListRow,
  filter: InboxFilter,
): boolean {
  return row.kind === "ask"
    ? matchesAskFilter(filter, row.interview.ask.channelType)
    : matchesInboxFilter(row.item, filter);
}

/**
 * The interleaved list order: unanswered asks PIN ABOVE conversations, then
 * newest activity first, then a stable id tiebreak.
 *
 * Asks pin because they are the badge's content — the list is where a person
 * goes to find what the badge is counting, and a buried ask (hours old, below
 * every newer conversation) reads as "one unread item I can't find" even
 * under the All filter (Sam, 2026-09-17). Asks are rare and demand an answer;
 * conversations are the ambient stream.
 */
export function compareInboxRows(a: InboxListRow, b: InboxListRow): number {
  const kindRank = (row: InboxListRow) => (row.kind === "ask" ? 0 : 1);
  const idOf = (row: InboxListRow) =>
    row.kind === "ask" ? row.interview.id : row.item.conversationId;
  return (
    kindRank(a) - kindRank(b) ||
    inboxRowSortAt(b) - inboxRowSortAt(a) ||
    idOf(a).localeCompare(idOf(b))
  );
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
