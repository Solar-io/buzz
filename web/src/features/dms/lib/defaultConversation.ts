/**
 * Default-open conversation decision (D-025 round 3). Pure logic so the
 * timing semantics are testable without a relay.
 *
 * History: the first cut waited a fixed 1.2s courtesy beat and then
 * required a message-bearing DM. On a cold PWA start (fresh TLS + WS +
 * AUTH, first parse of a new bundle) the per-DM sampling subs have not
 * answered inside 1.2s, every lastActivity reads 0, and the pick opened
 * nothing — the picker stood (Sam's 16:45 round). The comment in the
 * route promised "first sample or 1.2s, whichever first"; the first-sample
 * leg was never wired. This module is the wiring, done right:
 *
 *   - WAIT until the durable sampling window settles (EOSE across every
 *     per-DM batch) — "most recent" must mean most recent, not
 *     first-loaded (the D-025 roulette lesson), so there is deliberately
 *     no early-fire on the first sample.
 *   - HARD CAP (5s): a dead relay still falls through to the picker
 *     rather than hanging the landing forever.
 *   - PICK: most recent DM with real message activity; a lone visible DM
 *     opens even unmessaged (it is the only conversation there is);
 *     otherwise the empty state stands.
 */

export type DefaultConversationDecision =
  | { action: "wait" }
  | { action: "handled" }
  | { action: "open"; index: number }
  | { action: "stand-down" };

export interface DefaultConversationInputs {
  /** The pick already ran (or was retired) this app load. */
  handled: boolean;
  /** A deep link (?c= / ?view=) or user selection already chose. */
  userAlreadySelected: boolean;
  connected: boolean;
  channelCount: number;
  /** True when every per-DM sampling batch hit EOSE (or there are no DMs). */
  samplingSettled: boolean;
  /** True past the hard cap (5s) — the dead-relay escape hatch. */
  hardCapElapsed: boolean;
  /**
   * Visible DMs in the list's own order (activity-sorted, hidden excluded).
   * Only lastActivity is consulted here.
   */
  visibleDms: ReadonlyArray<{ lastActivity: number }>;
}

export function decideDefaultConversation(
  inputs: DefaultConversationInputs,
): DefaultConversationDecision {
  const {
    handled,
    userAlreadySelected,
    connected,
    channelCount,
    samplingSettled,
    hardCapElapsed,
    visibleDms,
  } = inputs;

  if (handled || userAlreadySelected) {
    return { action: "handled" };
  }
  if (!connected || channelCount === 0) {
    return { action: "wait" };
  }
  // The round-3 fix: hold the pick until the durable window settles.
  // The hard cap is the only path past an unsettled window.
  if (!samplingSettled && !hardCapElapsed) {
    return { action: "wait" };
  }

  const messaged = visibleDms.findIndex((dm) => dm.lastActivity > 0);
  if (messaged !== -1) {
    return { action: "open", index: messaged };
  }
  if (visibleDms.length === 1) {
    return { action: "open", index: 0 };
  }
  return { action: "stand-down" };
}
