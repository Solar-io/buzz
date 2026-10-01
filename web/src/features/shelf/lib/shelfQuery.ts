/**
 * REQ filters for the Shelf (phase-6.md "Shelf query (web)").
 *
 * - `#t:["shelf"]` is pushed into SQL before the LIMIT (D6.3), so a page of
 *   200 is 200 shares, not the newest 200 messages post-filtered.
 * - Every readable channel rides in `#h`, 128 to a filter, one REQ each: a
 *   share is channel-scoped, and the relay fans a channel-scoped event out
 *   only to subscriptions that name its channel (AGENTS.md gotcha 11). A
 *   filter without `#h` would read history and then go silent.
 * - Type and sender filters run client-side, from `imeta` and `pubkey`.
 *
 * Import-free apart from types, so `node --test` loads it.
 */

import type { NostrFilter } from "@/shared/lib/nostr-client";
import { SHARE_KINDS, SHELF_TOPIC } from "./shareEvent.ts";

/** Shares per channel chunk (the plan's page). */
export const SHELF_PAGE_LIMIT = 200;
/** Relay cap on `#h` values per filter (`inboxQuery.ts`). */
export const MAX_H_PER_FILTER = 128;
/** Comments read per file (thread replies to the share). */
export const COMMENTS_LIMIT = 200;

/** History + live shares, one filter per 128 channels. */
export function shelfFilters(channelIds: readonly string[]): NostrFilter[] {
  const ids = [...new Set(channelIds)].filter((id) => id !== "").sort();
  const filters: NostrFilter[] = [];
  for (let start = 0; start < ids.length; start += MAX_H_PER_FILTER) {
    filters.push({
      kinds: [...SHARE_KINDS],
      "#t": [SHELF_TOPIC],
      "#h": ids.slice(start, start + MAX_H_PER_FILTER),
      limit: SHELF_PAGE_LIMIT,
    });
  }
  return filters;
}

/**
 * Comments on a file: every chat message in the share's channel that
 * e-references the share (a reply's root OR parent marker). `#h` keeps it in
 * the channel index, so new comments arrive live.
 */
export function fileCommentsFilter(share: {
  id: string;
  channelId: string;
}): NostrFilter {
  return {
    kinds: [9],
    "#e": [share.id],
    "#h": [share.channelId],
    limit: COMMENTS_LIMIT,
  };
}
