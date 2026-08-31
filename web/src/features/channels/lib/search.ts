/**
 * NIP-50 search: the relay serves Postgres FTS over one-shot REQs
 * ({search, kinds, #h, limit} → events → EOSE). This module builds the
 * filter and shapes hits for the results panel.
 */

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { TIMELINE_KINDS } from "./messageBuffer.ts";

export type SearchScope = "all" | "channel";

/**
 * Filter for a search REQ. Returns null for queries too short to bother the
 * relay with. `#h` scopes to one channel (the relay intersects it with the
 * requester's accessible set — it can never widen visibility).
 */
export function searchFilter(
  query: string,
  scope: SearchScope,
  channelId: string | null,
): { kinds: number[]; search: string; limit: number; "#h"?: string[] } | null {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return null;
  }
  const filter: {
    kinds: number[];
    search: string;
    limit: number;
    "#h"?: string[];
  } = {
    kinds: [...TIMELINE_KINDS],
    search: trimmed,
    limit: 50,
  };
  if (scope === "channel" && channelId) {
    filter["#h"] = [channelId];
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

/** Hit from a search event — requires an h tag (channel-scoped storage). */
export function searchHitFromEvent(event: SignedNostrEvent): SearchHit | null {
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

/** Newest first — the relay orders by relevance, the panel by recency. */
export function sortHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Excerpt around the first case-insensitive match of the query's first term.
 * Long messages show context on both sides; short ones show in full.
 */
export function excerpt(content: string, query: string, radius = 48): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  const term = query.trim().split(/\s+/)[0] ?? "";
  const at =
    term.length > 0 ? flattened.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (at === -1) {
    return (
      flattened.slice(0, radius * 2) +
      (flattened.length > radius * 2 ? "…" : "")
    );
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(flattened.length, at + term.length + radius);
  return (
    (start > 0 ? "…" : "") +
    flattened.slice(start, end) +
    (end < flattened.length ? "…" : "")
  );
}
