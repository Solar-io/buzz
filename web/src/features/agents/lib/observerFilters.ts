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
 * Frames retained per agent, and it must be large enough to hold a whole
 * fetched page — otherwise the panel silently throws away most of what it
 * just asked the relay for.
 *
 * The unit mismatch is the trap: HISTORY_LIMIT counts ENVELOPES, this counts
 * FRAMES, and the harness batches, so one envelope expands into several.
 * Measured on the dev relay, a 500-envelope page expands to 895-1101 frames.
 *
 * Undersizing this does not degrade gracefully. `capFrames` keeps the newest
 * frames, and the newest frames of a coding turn are tool_call_update and
 * usage_update spam — so a cap that trims at all trims the THINKING first.
 * At 600 an agent with 52 thought chunks in its page rendered zero of them,
 * while a less tool-heavy agent kept 138 of 234 and therefore looked fine.
 * That is why this read as "works for some agents, not others".
 */
export const FRAMES_PER_AGENT = 2000;

/**
 * The always-on subscription: every frame addressed to the viewer, bounded.
 *
 * `limit` here is explicitness, not a behaviour change — a WS REQ that omits
 * it already defaults to `DEFAULT_MAX_PAGE_LIMIT`
 * (`crates/buzz-relay/src/handlers/req.rs:699`), which is this same 1000. The
 * `since` is the part that bites, and it is deliberate: this REQ exists for
 * the sidebar dots and the working timers, both of which read a 180-second
 * freshness window (`WORKING_STALE_SECONDS`), so a five-minute lookback
 * covers them with margin while leaving the shared page free of history that
 * belongs to `agentHistoryFilter`.
 *
 * What it must NOT be is the only source of a panel's history. Measured
 * against the dev relay on 2026-09-05, signed in as the owner: this filter
 * without `since` returned the relay's full 1000-event page, and those 1000
 * events covered FOUR agents — of twenty-three with retained history — with
 * 714 of the 1000 slots taken by a single agent. Nineteen agents' panels were
 * empty, not because their frames were missing but because a chattier
 * neighbour had crowded them out of one shared page.
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
 *
 * This is the load-bearing half of the fix. Verified against the dev relay:
 * an agent whose 172 retained frames span Aug 31 - Sep 2 was entirely absent
 * from the shared page and returns all 172 here, every one of them decrypting
 * with the owner key.
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
