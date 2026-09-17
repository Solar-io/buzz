import type { NostrFilter } from "@/shared/lib/nostr-client";
import {
  MAX_CHANNELS_PER_REQUEST,
  MAX_FILTERS_PER_REQUEST,
  type InboxRequest,
  chunkChannelIds,
  isChannelScopedRequest,
} from "./inboxQuery.ts";

/**
 * Relay request shapes for answer detection — the half of the Asks inbox
 * that watches for MY replies to tracked cards.
 *
 * ## Why `#e` and what the relay does with it
 *
 * An answer is an ordinary kind 9 whose reply-marker e-tag names the card
 * (`DecisionCard.tsx` threadRef). `#e` is fully pushed for any value count on
 * the relay via JSONB containment (`filter_fully_pushable`, the `"e"` arm of
 * `crates/buzz-relay/src/handlers/req.rs`; pushdown into `EventQuery.e_tags`),
 * so a `#e` list of tracked card ids is an indexed lookup, not a scan. There
 * is no `#e` value-count cap on the WS REQ path — the 128 cap is `#h`-only —
 * but the filters here still batch card ids to keep every REQ small and
 * inside the NIP-11 `max_filters` budget.
 *
 * ## The scope rule (mirrors inboxQuery rule 2)
 *
 * History is deliberately GLOBAL (no `#h`): a global filter resolves against
 * the full accessible-channel scope, which is what covers answers landing in
 * DMs. Live MUST carry `#h` per channel chunk — a `#h`-less filter is never a
 * live fan-out candidate, and mixing the two shapes in one REQ un-lives the
 * whole subscription (`extract_channel_ids_from_filters` bails to Global).
 * The two builders therefore never share a REQ, and the test suite pins that.
 */

/** Chat message kind — answers are kind 9 replies. */
export const ANSWER_KIND = 9;

/** Tracked card ids per `#e` filter — keeps individual REQs bounded. */
export const CARD_IDS_PER_FILTER = 50;

/** Stored answers per history filter. */
export const ANSWER_HISTORY_LIMIT = 500;

/** Stored answers per targeted (single-card) query on row tap. */
export const TARGETED_ANSWER_LIMIT = 100;

/** Split tracked card ids into filter-sized batches. */
function chunkCardIds(cardIds: readonly string[]): string[][] {
  const unique = Array.from(new Set(cardIds)).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += CARD_IDS_PER_FILTER) {
    batches.push(unique.slice(i, i + CARD_IDS_PER_FILTER));
  }
  return batches;
}

/** Group filters into REQs the relay's max_filters accepts. */
function groupIntoRequests(filters: NostrFilter[]): InboxRequest[] {
  const requests: InboxRequest[] = [];
  for (let i = 0; i < filters.length; i += MAX_FILTERS_PER_REQUEST) {
    requests.push(filters.slice(i, i + MAX_FILTERS_PER_REQUEST));
  }
  return requests;
}

/**
 * History answers for a batch of tracked card ids, in one global REQ family.
 *
 * No `#h`, history only — the live half is {@link answerLiveRequests}' job.
 * Runs on mount, whenever the tracked set changes, and as a heartbeat.
 */
export function answerHistoryRequests(
  cardIds: readonly string[],
): InboxRequest[] {
  return groupIntoRequests(
    chunkCardIds(cardIds).map((batch) => ({
      kinds: [ANSWER_KIND],
      "#e": batch,
      limit: ANSWER_HISTORY_LIMIT,
    })),
  );
}

/**
 * Live answers, per 128-channel chunk. Every filter carries `#h` (so the
 * subscription registers in the channel index and actually fans out) AND the
 * `#e` predicate (re-checked at fan-out time — `push_match` runs the full
 * filter match on every candidate). `since` makes it live-only.
 */
export function answerLiveRequests(
  cardIds: readonly string[],
  channelIds: readonly string[],
  since: number,
): InboxRequest[] {
  const idBatches = chunkCardIds(cardIds);
  if (idBatches.length === 0) {
    return [];
  }
  const requests: InboxRequest[] = [];
  for (const chunk of chunkChannelIds(channelIds, MAX_CHANNELS_PER_REQUEST)) {
    const filters = idBatches.map((batch) => ({
      kinds: [ANSWER_KIND],
      "#h": chunk,
      "#e": batch,
      since,
    }));
    requests.push(...groupIntoRequests(filters));
  }
  return requests;
}

/**
 * The targeted query fired when an ask row is TAPPED: one card, one cheap
 * global REQ, so a missed historical answer clears the badge at the moment
 * of attention even if every window before it missed.
 */
export function targetedAnswerRequest(cardId: string): InboxRequest {
  return [
    {
      kinds: [ANSWER_KIND],
      "#e": [cardId],
      limit: TARGETED_ANSWER_LIMIT,
    },
  ];
}

/**
 * Liveness invariant for the live answer REQs — every filter carries `#h`.
 * Exported for the suite, which pins it the way `inboxQuery.test.mjs` does.
 */
export function allRequestsChannelScoped(
  requests: readonly InboxRequest[],
): boolean {
  return requests.every(isChannelScopedRequest);
}
