import type { NostrFilter } from "@/shared/lib/nostr-client.ts";

/** Owner-scoped encrypted agent observer telemetry. */
export const KIND_AGENT_OBSERVER_FRAME = 24200;

/**
 * Live REQ page and lookback, matching the desktop's observer subscription
 * (`desktop/src/shared/api/observerRelay.ts`). The lookback covers a turn
 * that began before this tab connected; the limit caps the burst a busy
 * fleet can replay on reconnect.
 */
export const LIVE_LIMIT = 1000;
export const LIVE_LOOKBACK_SECONDS = 300;

/** One-shot per-agent history page, fetched when an agent's panel opens. */
export const HISTORY_LIMIT = 500;

/**
 * The always-on subscription: every frame addressed to the viewer, bounded.
 *
 * The `limit` is not optional decoration. `query_events` uses
 * `q.limit.unwrap_or(100)` (`crates/buzz-db/src/event.rs`), so a filter that
 * omits it is answered with ONE HUNDRED events shared across every agent,
 * newest first — and a working agent emits 4-10 frames/sec. Measured against
 * the dev relay on 2026-09-05, with eight agents active over the preceding 30
 * hours, that page spanned twelve minutes and covered three agents, one of
 * which held 80 of the 100 slots.
 */
export function liveObserverFilter(
  ownerPubkey: string,
  nowSeconds: number,
): NostrFilter {
  return {
    kinds: [KIND_AGENT_OBSERVER_FRAME],
    "#p": [ownerPubkey],
    limit: LIVE_LIMIT,
    since: nowSeconds - LIVE_LOOKBACK_SECONDS,
  };
}

/**
 * One agent's retained history, independent of what its neighbours emit.
 *
 * `authors` is an exact discriminator: the relay requires an observer frame's
 * signer to be the agent it describes (`agent_observer_route` in
 * `crates/buzz-relay/src/handlers/event.rs`), and it is pushed into SQL
 * alongside the `#p` join, so this page is the agent's own — never a slice of
 * a shared one.
 *
 * `#p` is still required: it is what the relay's p-gate authorizes the
 * subscription against (`p_gated_filters_authorized`). A filter carrying only
 * `authors` is refused.
 */
export function agentHistoryFilter(
  ownerPubkey: string,
  agentPubkey: string,
): NostrFilter {
  return {
    kinds: [KIND_AGENT_OBSERVER_FRAME],
    "#p": [ownerPubkey],
    authors: [agentPubkey],
    limit: HISTORY_LIMIT,
  };
}
