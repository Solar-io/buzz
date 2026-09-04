/**
 * Turning a typed query into a relay REQ filter.
 *
 * NIP-50 search runs as an ordinary one-shot REQ: `{kinds, search, #h,
 * authors, since, until, limit}`. Two constraints from the relay shape what
 * this may emit:
 *
 * - **`kinds` is mandatory.** A filter without it trips the relay's p-gate and
 *   comes back 403, so the kind list is a required argument here rather than
 *   an option with a default that could go missing.
 * - **`#h` narrows, never widens.** The relay intersects it with the set of
 *   channels the requester may read, so scoping to a channel is always safe;
 *   omitting it searches everything the viewer can see, not everything.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

import type { ParsedSearchOperators } from "./parseSearchOperators.ts";

/** Two characters is the floor for an unscoped search… */
export const MIN_SEARCH_QUERY_LENGTH = 2;
/** …but one is enough once the search is pinned to a single channel. */
export const MIN_SCOPED_SEARCH_QUERY_LENGTH = 1;

export function minimumQueryLength(scopeChannelId: string | null): number {
  return scopeChannelId
    ? MIN_SCOPED_SEARCH_QUERY_LENGTH
    : MIN_SEARCH_QUERY_LENGTH;
}

/**
 * A type ALIAS, not an interface, and that is load-bearing: TypeScript infers
 * an implicit index signature for object type aliases but never for
 * interfaces, so an interface here is not assignable to `NostrFilter` (whose
 * `#`-tag keys are an index signature) and `session.subscribe` rejects it.
 */
export type SearchFilter = {
  kinds: number[];
  search: string;
  limit: number;
  "#h"?: string[];
  authors?: string[];
  since?: number;
  until?: number;
};

export interface BuildSearchFilterInput {
  parsed: ParsedSearchOperators;
  kinds: readonly number[];
  limit?: number;
  /** Channel the search is pinned to (scope chip, or a resolved `in:`). */
  channelId?: string | null;
  /** Author the search is pinned to (a resolved `from:`). */
  author?: string | null;
  /**
   * True when an operator was written but matched nothing. The caller must
   * NOT search: widening back to everything answers a different question
   * than the one asked.
   */
  hasUnresolvedOperator?: boolean;
}

/**
 * Build the REQ filter, or null when there is nothing to ask for.
 *
 * A date operator alone is deliberately *not* enough: `after:2025-01-01` with
 * no text would ask the relay to full-text-search the empty string across
 * every channel, which is a table scan dressed as a query.
 */
export function buildSearchFilter(
  input: BuildSearchFilterInput,
): SearchFilter | null {
  if (input.hasUnresolvedOperator) {
    return null;
  }
  const text = input.parsed.text.trim();
  const channelId = input.channelId ?? null;
  if (text.length < minimumQueryLength(channelId)) {
    return null;
  }
  if (input.kinds.length === 0) {
    return null;
  }
  const filter: SearchFilter = {
    kinds: [...input.kinds],
    search: text,
    limit: input.limit ?? 50,
  };
  if (channelId) {
    filter["#h"] = [channelId];
  }
  if (input.author) {
    filter.authors = [input.author.toLowerCase()];
  }
  if (input.parsed.since !== null) {
    filter.since = input.parsed.since;
  }
  if (input.parsed.until !== null) {
    filter.until = input.parsed.until;
  }
  return filter;
}

export interface SearchHit {
  id: string;
  channelId: string;
  authorPubkey: string;
  createdAt: number;
  content: string;
}

/**
 * Shape a hit from an event.
 *
 * An `h` tag is required: every searchable message is stored channel-scoped,
 * and a hit with no channel cannot be opened, so it is dropped rather than
 * rendered as a row that goes nowhere when clicked.
 */
export function searchHitFromEvent(event: {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}): SearchHit | null {
  const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!channelId) {
    return null;
  }
  return {
    id: event.id,
    channelId,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    content: event.content,
  };
}

/** Newest first. The relay orders by relevance; the panel reads by recency. */
export function sortHits(hits: readonly SearchHit[]): SearchHit[] {
  return [...hits].sort((left, right) => right.createdAt - left.createdAt);
}

/** Drop repeats by event id, keeping the first seen. */
export function dedupeHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const unique: SearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) {
      continue;
    }
    seen.add(hit.id);
    unique.push(hit);
  }
  return unique;
}
