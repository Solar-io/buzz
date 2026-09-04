/**
 * Kind 39005 — the relay's materialised thread counters.
 *
 * The relay keeps `reply_count` (direct children) and `descendant_count`
 * (the whole subtree) on every thread root in `thread_metadata`, and
 * publishes them as a relay-signed kind-39005 overlay whenever a reply
 * commits (`emit_live_thread_summary` in
 * `crates/buzz-relay/src/handlers/side_effects.rs`). Tags are `e` = root id,
 * `d` = root id, `h` = channel id; content is
 * `{reply_count, descendant_count, last_reply_at, participants}`.
 *
 * Two things follow, and both shaped this module:
 *
 * 1. It is CHANNEL-SCOPED (`h`), so it rides the channel's own REQ. It does
 *    not need — and must not get — a filter of its own without `#h`, which
 *    would register the whole subscription as global and un-live every other
 *    filter in it (`extract_channel_ids_from_filters`).
 * 2. It is NEVER STORED ("synthesized at query time, never stored" —
 *    `kind.rs`), so a historical REQ returns none. A client sees a root's
 *    relay counters only when a reply lands while it is subscribed, or by
 *    asking the HTTP bridge for a channel window with `include_summaries`.
 *    The local tree count is therefore the floor, not the fallback: see
 *    `mergeThreadCounts`.
 */

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/** Kind 39005 — relay-signed thread summary overlay. */
export const THREAD_SUMMARY_KIND = 39005;

export interface RelayThreadSummary {
  /** Thread root event id (the `e`/`d` tag). */
  rootId: string;
  /** Channel the root lives in (`h` tag), for scoping checks. */
  channelId: string | null;
  /** Direct children of the root. */
  replyCount: number;
  /** Every descendant of the root, at any depth. */
  descendantCount: number;
  /** Unix seconds of the newest reply, or null. */
  lastReplyAt: number | null;
  /** Participant pubkeys, most recent first (the relay's own order). */
  participants: string[];
  /** created_at of the overlay event — newest wins per root. */
  at: number;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Parse a 39005 into a summary, or null when it is not one / is malformed.
 * A summary with no usable root id is worthless — it cannot be keyed.
 */
export function relayThreadSummaryFromEvent(
  event: SignedNostrEvent,
): RelayThreadSummary | null {
  if (event.kind !== THREAD_SUMMARY_KIND) {
    return null;
  }
  const rootId =
    event.tags.find(
      (tag) => tag[0] === "e" && typeof tag[1] === "string",
    )?.[1] ??
    event.tags.find((tag) => tag[0] === "d" && typeof tag[1] === "string")?.[1];
  if (!rootId) {
    return null;
  }
  let parsed: {
    reply_count?: unknown;
    descendant_count?: unknown;
    last_reply_at?: unknown;
    participants?: unknown;
  };
  try {
    parsed = JSON.parse(event.content) as typeof parsed;
  } catch {
    return null;
  }
  const lastReplyAt =
    typeof parsed.last_reply_at === "number" &&
    Number.isFinite(parsed.last_reply_at)
      ? parsed.last_reply_at
      : null;
  return {
    rootId,
    channelId:
      event.tags.find(
        (tag) => tag[0] === "h" && typeof tag[1] === "string",
      )?.[1] ?? null,
    replyCount: asCount(parsed.reply_count),
    descendantCount: asCount(parsed.descendant_count),
    lastReplyAt,
    participants: Array.isArray(parsed.participants)
      ? parsed.participants.filter(
          (pubkey): pubkey is string => typeof pubkey === "string",
        )
      : [],
    at: event.created_at,
  };
}

export type RelayThreadSummaryMap = ReadonlyMap<string, RelayThreadSummary>;

/**
 * Fold a summary into the map, newest-wins per root.
 *
 * Returns the SAME reference when the incoming summary is not newer, so a
 * React state update on a duplicate is a no-op (the same discipline
 * `upsertMessage` follows).
 */
export function mergeRelayThreadSummary(
  current: RelayThreadSummaryMap,
  summary: RelayThreadSummary,
): RelayThreadSummaryMap {
  const existing = current.get(summary.rootId);
  if (existing && existing.at >= summary.at) {
    return current;
  }
  const next = new Map(current);
  next.set(summary.rootId, summary);
  return next;
}

export interface MergedThreadCounts {
  /** Direct children. */
  replyCount: number;
  /** Every descendant. */
  descendantCount: number;
  lastReplyAt: number | null;
  /** Oldest-first for the facepile, deduped, capped by `participantLimit`. */
  participants: string[];
}

/**
 * Reconcile what this client can see with what the relay knows.
 *
 * The local tree only counts replies inside the loaded buffer, and the relay
 * overlay only arrives for roots that got a reply while we were listening.
 * Neither is authoritative on its own, so take the MAX of each count — a
 * disagreement always means one side is missing rows, never that one side
 * over-counted.
 *
 * Participants merge as a set with the local (oldest-first) order leading,
 * because those are the ones whose profiles are already resolved.
 */
export function mergeThreadCounts(
  local: {
    replyCount: number;
    descendantCount: number;
    lastReplyAt: number | null;
    participants: readonly string[];
  },
  relay: RelayThreadSummary | null | undefined,
  participantLimit = 3,
): MergedThreadCounts {
  if (!relay) {
    return {
      replyCount: local.replyCount,
      descendantCount: local.descendantCount,
      lastReplyAt: local.lastReplyAt,
      participants: [...local.participants].slice(-participantLimit),
    };
  }
  const merged: string[] = [];
  // Relay order is newest-first; reverse it to the oldest-first order the
  // facepile draws, then let local entries fill any remaining slots.
  for (const pubkey of [
    ...[...relay.participants].reverse(),
    ...local.participants,
  ]) {
    if (!merged.includes(pubkey)) {
      merged.push(pubkey);
    }
  }
  return {
    replyCount: Math.max(local.replyCount, relay.replyCount),
    descendantCount: Math.max(local.descendantCount, relay.descendantCount),
    lastReplyAt:
      Math.max(local.lastReplyAt ?? 0, relay.lastReplyAt ?? 0) || null,
    participants: merged.slice(-participantLimit),
  };
}
