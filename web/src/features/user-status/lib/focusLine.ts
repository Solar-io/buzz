import { statusLabel, type UserStatus } from "./statusEvent.ts";

/**
 * NIP-38 user status → the roster's one-line focus indicator
 * ("🔧 buzz-ui · 2h").
 *
 * The roster's promise is CURRENT focus, so a claim older than a working day
 * renders nothing — honest-absent, the same stance as every gated control on
 * the agents screen. The profile popover keeps showing any age (it answers
 * "what they SAID they are doing", which tolerates staleness); this module
 * is the roster's stricter read of the same plane. Scope:
 * `~/.buzz/PLANS/AGENT_FOCUS_INDICATOR_SCOPE.md` §4.
 *
 * Pure by house rule: no React, no clock reads — `nowSeconds` is always a
 * parameter, so tests can pin every bucket and boundary.
 */

/**
 * Age past which a status stops counting as current focus on the roster.
 * 24h is the first value that covers a full working day past setting; it is
 * one named constant if it ever needs tuning.
 */
export const MAX_AGE_SECONDS = 24 * 3600;

/** The rendered line, already split for the caller's "label · age" join. */
export interface FocusLine {
  label: string;
  age: string;
}

/** "45m" under an hour, whole hours ("2h") above it. */
function ageBucket(ageSeconds: number): string {
  if (ageSeconds < 3600) {
    return `${Math.floor(ageSeconds / 60)}m`;
  }
  return `${Math.floor(ageSeconds / 3600)}h`;
}

/**
 * The roster focus line for one author's status, or null when there is
 * nothing current to show: absent status, blank label, or age at/past
 * `MAX_AGE_SECONDS`. Null means render NOTHING — no placeholder, no "—".
 */
export function focusLine(
  status: UserStatus | null | undefined,
  nowSeconds: number,
): FocusLine | null {
  if (status === null || status === undefined) {
    return null;
  }
  const label = statusLabel(status);
  if (label === "") {
    return null;
  }
  // Clamped so a future-dated event (clock skew) never shows a negative age.
  const ageSeconds = Math.max(0, nowSeconds - status.updatedAt);
  if (ageSeconds >= MAX_AGE_SECONDS) {
    return null;
  }
  return { label, age: ageBucket(ageSeconds) };
}

/**
 * Text-only focus token for the DM row: the status text alone — no emoji,
 * no age suffix (that row already carries its own times on the right;
 * Sam, 2026-09-06). An emoji-only status therefore has no token. Same
 * absence and staleness rules as focusLine; null renders NOTHING.
 */
export function focusToken(
  status: UserStatus | null | undefined,
  nowSeconds: number,
): string | null {
  if (status === null || status === undefined) {
    return null;
  }
  if (status.text === "") {
    return null;
  }
  const ageSeconds = Math.max(0, nowSeconds - status.updatedAt);
  if (ageSeconds >= MAX_AGE_SECONDS) {
    return null;
  }
  return status.text;
}
