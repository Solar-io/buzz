/**
 * REQ filters for Items (phase-5.md "Query for the Items page").
 *
 * - History: `{kinds:[30623], limit:1000}` returns every head in the
 *   reader's channels plus the global ones. A FULL page means there may be
 *   more, so the provider pages back with `until` (risk R5).
 * - Live: a filter without `#h` gets history and live GLOBAL heads only — a
 *   channel-scoped head is fanned out to subscriptions that name its channel
 *   (AGENTS.md gotcha 11). So every readable channel id rides in `#h`, 128
 *   to a filter, each in its own REQ (never mixed with an `#h`-less one).
 * - Never `#p`, status or type at the relay (D5.6): fold first, filter after.
 *
 * Import-free apart from types, so `node --test` loads it.
 */

import type { NostrFilter } from "@/shared/lib/nostr-client";
import { KIND_ITEM } from "./itemEvent.ts";

/** The relay's advertised `max_limit` (`buzz-db/src/event.rs`). */
export const ITEMS_PAGE_LIMIT = 1000;
/** Pages fetched back past the first before giving up (~11k heads). */
export const ITEMS_MAX_EXTRA_PAGES = 10;
/** Relay cap on `#h` values per filter (`inboxQuery.ts`). */
const MAX_H_PER_FILTER = 128;
/** Kinds a source message can be: stream, v2 stream, forum post, comment. */
export const SOURCE_KINDS = [9, 40002, 45001, 45003];
/** Kind 39002: a channel's member roster. */
const GROUP_MEMBERS_KIND = 39002;

export function itemsHistoryFilter(until?: number): NostrFilter {
  return until === undefined
    ? { kinds: [KIND_ITEM], limit: ITEMS_PAGE_LIMIT }
    : { kinds: [KIND_ITEM], until, limit: ITEMS_PAGE_LIMIT };
}

/** One filter per 128 channels: live heads for items with a source channel. */
export function itemsLiveFilters(
  channelIds: readonly string[],
  nowS: number,
): NostrFilter[] {
  const ids = [...new Set(channelIds)].sort();
  const filters: NostrFilter[] = [];
  for (let start = 0; start < ids.length; start += MAX_H_PER_FILTER) {
    filters.push({
      kinds: [KIND_ITEM],
      "#h": ids.slice(start, start + MAX_H_PER_FILTER),
      since: nowS,
    });
  }
  return filters;
}

/** The messages items were captured from, by id. */
export function sourceMessagesFilter(eventIds: readonly string[]): NostrFilter {
  return { ids: [...new Set(eventIds)].sort(), kinds: [...SOURCE_KINDS] };
}

/** Rosters for the channels a handoff or assignment is picked in. */
export function rostersFilter(channelIds: readonly string[]): NostrFilter {
  const ids = [...new Set(channelIds)].sort();
  return { kinds: [GROUP_MEMBERS_KIND], "#d": ids, limit: 10 * ids.length };
}

/**
 * Where the next history page starts, or null when paging is done: the page
 * was short (the relay had no more), nothing older arrived (a second full of
 * heads cannot be paged past with `until` alone), or the budget is spent.
 */
export function nextPageUntil(input: {
  pageSize: number;
  pageOldest: number;
  previousUntil: number | null;
  pagesFetched: number;
}): number | null {
  if (input.pageSize < ITEMS_PAGE_LIMIT) {
    return null;
  }
  if (input.pagesFetched > ITEMS_MAX_EXTRA_PAGES) {
    return null;
  }
  if (input.previousUntil !== null && input.pageOldest >= input.previousUntil) {
    return null;
  }
  return input.pageOldest;
}
