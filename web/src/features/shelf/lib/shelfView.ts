/**
 * The Shelf page's list as a pure function of the shares and the filters
 * (Shelf artboard): newest first, grouped by day, filtered by type, sender,
 * channel and text.
 *
 * Counts follow the Items rule — a chip's number is what the list would show
 * if you picked it: every filter EXCEPT the type applies before counting, and
 * the count is of files, since a type chip narrows a share to its matching
 * files.
 *
 * Pure so `node --test` loads it directly.
 */

import {
  type FileKind,
  SHELF_CATEGORIES,
  type ShelfCategory,
  shelfCategory,
} from "./fileKind.ts";
import type { Share, ShareFile } from "./shareEvent.ts";

export type CategoryFilter = "all" | ShelfCategory;
export type SenderFilter = "anyone" | "me" | { pubkey: string };
export type ChannelFilter = "anywhere" | { id: string };

export interface ShelfFilters {
  category: CategoryFilter;
  sender: SenderFilter;
  channel: ChannelFilter;
  text: string;
}

export const DEFAULT_SHELF_FILTERS: ShelfFilters = {
  category: "all",
  sender: "anyone",
  channel: "anywhere",
  text: "",
};

export interface ShelfRow {
  share: Share;
  /** The share's files that pass the type filter (all of them under All). */
  files: ShareFile[];
}

export interface ShelfResult {
  rows: ShelfRow[];
  counts: Record<CategoryFilter, number>;
}

/** Newest first; id breaks a same-second tie so the order never flickers. */
export function sortShares(shares: readonly Share[]): Share[] {
  return [...shares].sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

function matchesSender(
  share: Share,
  sender: SenderFilter,
  selfPubkey: string | null,
): boolean {
  if (sender === "anyone") {
    return true;
  }
  if (sender === "me") {
    return selfPubkey !== null && share.authorPubkey === selfPubkey;
  }
  return share.authorPubkey === sender.pubkey;
}

function matchesText(
  share: Share,
  needle: string,
  names: { channel: (id: string) => string; person: (pk: string) => string },
): boolean {
  if (needle === "") {
    return true;
  }
  const haystack = [
    share.summary,
    names.channel(share.channelId),
    names.person(share.authorPubkey),
    ...share.files.map((file) => file.filename),
  ]
    .join("\n")
    .toLowerCase();
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function categoryOf(kind: FileKind): ShelfCategory {
  return shelfCategory(kind);
}

export function filterShares(
  shares: readonly Share[],
  filters: ShelfFilters,
  context: {
    selfPubkey: string | null;
    channelName: (id: string) => string;
    personName: (pubkey: string) => string;
  },
): ShelfResult {
  const counts = Object.fromEntries([
    ["all", 0],
    ...SHELF_CATEGORIES.map((category) => [category, 0]),
  ]) as Record<CategoryFilter, number>;
  const rows: ShelfRow[] = [];
  const needle = filters.text.trim().toLowerCase();
  for (const share of sortShares(shares)) {
    if (!matchesSender(share, filters.sender, context.selfPubkey)) {
      continue;
    }
    if (
      filters.channel !== "anywhere" &&
      share.channelId !== filters.channel.id
    ) {
      continue;
    }
    if (
      !matchesText(share, needle, {
        channel: context.channelName,
        person: context.personName,
      })
    ) {
      continue;
    }
    for (const file of share.files) {
      counts.all += 1;
      counts[shelfCategory(file.kind)] += 1;
    }
    const files =
      filters.category === "all"
        ? share.files
        : share.files.filter(
            (file) => shelfCategory(file.kind) === filters.category,
          );
    if (files.length > 0) {
      rows.push({ share, files });
    }
  }
  return { rows, counts };
}

export interface DayGroup {
  key: string;
  label: string;
  rows: ShelfRow[];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Whole local days between two instants (0 = same day). */
function daysBetween(earlier: Date, later: Date): number {
  const a = new Date(
    earlier.getFullYear(),
    earlier.getMonth(),
    earlier.getDate(),
  );
  const b = new Date(later.getFullYear(), later.getMonth(), later.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** "Today", "Yesterday", "Monday" within the week, then "September 12". */
export function dayLabel(createdAt: number, nowS: number): string {
  const date = new Date(createdAt * 1000);
  const now = new Date(nowS * 1000);
  const days = daysBetween(date, now);
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** The When column: a clock today, a weekday this week, then a date. */
export function whenLabel(createdAt: number, nowS: number): string {
  const date = new Date(createdAt * 1000);
  const days = daysBetween(date, new Date(nowS * 1000));
  if (days <= 0) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (days < 7) {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Rows (already newest first) cut into local days. */
export function groupByDay(
  rows: readonly ShelfRow[],
  nowS: number,
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const key = dayKey(new Date(row.share.createdAt * 1000));
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.rows.push(row);
    } else {
      groups.push({
        key,
        label: dayLabel(row.share.createdAt, nowS),
        rows: [row],
      });
    }
  }
  return groups;
}

/** Senders, most shares first (the From menu). */
export function senderOptions(shares: readonly Share[]): string[] {
  const counts = new Map<string, number>();
  for (const share of shares) {
    counts.set(share.authorPubkey, (counts.get(share.authorPubkey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([pubkey]) => pubkey);
}

/** Channels that hold a share, most shares first (the In menu). */
export function channelOptions(shares: readonly Share[]): string[] {
  const counts = new Map<string, number>();
  for (const share of shares) {
    counts.set(share.channelId, (counts.get(share.channelId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

/**
 * Shares someone else posted since the viewer last looked at the Shelf — the
 * sidebar row's "N new". Before the first visit, today's count from others.
 */
export function newShareCount(
  shares: readonly Share[],
  lastSeenAt: number | null,
  selfPubkey: string | null,
  nowS: number,
): number {
  const since =
    lastSeenAt ??
    Math.floor(
      new Date(new Date(nowS * 1000).setHours(0, 0, 0, 0)).getTime() / 1000,
    );
  return shares.filter(
    (share) => share.createdAt > since && share.authorPubkey !== selfPubkey,
  ).length;
}
