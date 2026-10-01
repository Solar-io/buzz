/**
 * REQ filters for the Work tab's own subscriptions (phase-1 §2.7).
 *
 * The relay's rules, from `home/lib/inboxQuery.ts`: a filter with no `#h` is
 * served from the global `#p` index and gets HISTORY only; live fan-out needs
 * `#h` (the channel index). Never put an `#h`-less filter in the same REQ as
 * an `#h` one. At most 128 `#h` values per filter, 10 filters per REQ, and
 * every REQ names its kinds (an unkinded REQ trips the p-gate).
 */

import type { NostrFilter } from "@/shared/lib/nostr-client";
import { chunkChannelIds } from "@/features/home/lib/inboxQuery.ts";
import { APPROVAL_KINDS } from "./approvalEvents.ts";
import { QUEUED_TTL_S } from "./queuedReactions.ts";
import { KIND_AGENT_TASK_STATUS, STATUS_LOOKBACK_S } from "./taskStatus.ts";
import { KIND_AGENT_TURN_METRIC } from "./turnMetrics.ts";

const DAY_S = 86_400;
/** Approval history lookback — a gate older than two weeks has expired. */
export const APPROVAL_HISTORY_S = 14 * DAY_S;
/** Known agents the reaction REQ names, sorted, capped. */
export const MAX_REACTION_AUTHORS = 100;
/** Kinds a reacted-to message can be (stream, v2 stream, forum post/comment). */
export const TARGET_KINDS = [9, 40002, 45001, 45003];

export function approvalHistoryFilter(
  selfPubkey: string,
  nowS: number,
): NostrFilter {
  return {
    kinds: [...APPROVAL_KINDS],
    "#p": [selfPubkey],
    since: nowS - APPROVAL_HISTORY_S,
    limit: 500,
  };
}

export function approvalLiveFilters(
  selfPubkey: string,
  channelIds: readonly string[],
  nowS: number,
): NostrFilter[] {
  return chunkChannelIds(channelIds).map((chunk) => ({
    kinds: [...APPROVAL_KINDS],
    "#h": chunk,
    "#p": [selfPubkey],
    since: nowS,
  }));
}

/** One REQ per 128-channel chunk: 👀/💬 reactions and their deletions. */
export function reactionFilters(
  agentPubkeys: readonly string[],
  channelIds: readonly string[],
  nowS: number,
): NostrFilter[] {
  const authors = [...new Set(agentPubkeys)]
    .sort()
    .slice(0, MAX_REACTION_AUTHORS);
  if (authors.length === 0) {
    return [];
  }
  return chunkChannelIds(channelIds).map((chunk) => ({
    kinds: [7, 5],
    authors,
    "#h": chunk,
    since: nowS - QUEUED_TTL_S,
  }));
}

/**
 * Kind-30624 task status (Phase 8): one REQ per 128-channel chunk, history
 * AND live. It must carry `#h` — the relay fans a channel-scoped event out
 * only to subscriptions registered with that channel (AGENTS.md gotcha 11),
 * so an `#h`-less "everywhere" REQ would load the heads and then go deaf.
 */
export function taskStatusFilters(
  channelIds: readonly string[],
  nowS: number,
): NostrFilter[] {
  return chunkChannelIds(channelIds).map((chunk) => ({
    kinds: [KIND_AGENT_TASK_STATUS],
    "#h": chunk,
    since: nowS - STATUS_LOOKBACK_S,
  }));
}

export function metricsFilter(selfPubkey: string, sinceS: number): NostrFilter {
  return { kinds: [KIND_AGENT_TURN_METRIC], "#p": [selfPubkey], since: sinceS };
}

export function targetsFilter(eventIds: readonly string[]): NostrFilter {
  return { ids: [...eventIds], kinds: [...TARGET_KINDS] };
}
