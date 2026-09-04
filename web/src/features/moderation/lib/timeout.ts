/**
 * Reactive detection of a community timeout from a send rejection.
 *
 * There is no proactive self-restriction read: `/moderation/restricted` is
 * mod-gated (`api/bridge.rs::authorize_moderation_read` demands `ViewQueue`),
 * so a timed-out *member* is exactly the person who cannot read their own row.
 * The composer therefore learns it is blocked the only way available — by
 * attempting a send and parsing the refusal, which the relay emits in this
 * exact shape (`handlers/ingest.rs`, load-bearing parse contract):
 *
 *     restricted: you are timed out until <unix_seconds>
 *
 * A ban is a different message (`blocked: you are banned from this
 * community`) and is deliberately not parsed here — a ban has no countdown
 * and no lift-by-waiting, so it belongs in the normal error path.
 *
 * Import-free by design so the node test runner can load it directly.
 */

const TIMEOUT_PREFIX = "restricted: you are timed out until";

/**
 * Durations offered wherever a moderator picks a timeout length. One list, so
 * the per-message cluster can never drift from any later queue surface.
 */
export const TIMEOUT_PRESETS: ReadonlyArray<{
  label: string;
  seconds: number;
}> = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
];

/**
 * Convert a preset duration into the absolute expiry (epoch **seconds**) the
 * kind-9042 `expiration` tag expects — `now + seconds`. The relay stamps its
 * own authoritative expiry; this is only the client's request.
 */
export function timeoutExpiresAt(
  seconds: number,
  nowMs: number = Date.now(),
): number {
  return Math.floor(nowMs / 1000) + seconds;
}

export interface TimeoutRejection {
  /**
   * Timeout expiry in epoch milliseconds, or `null` when the relay's message
   * carried an unparseable timestamp. A `null` expiry still means "timed
   * out" — the banner shows without a countdown rather than pretending the
   * member can send.
   */
  expiresAtMs: number | null;
}

/**
 * Parse a relay send-rejection. Returns a {@link TimeoutRejection} when the
 * message is a timeout refusal, or `null` for any other rejection (which the
 * caller surfaces through its normal error path, untouched).
 *
 * Defensive by contract: the prefix identifies a timeout; the timestamp is
 * best-effort. A malformed trailing value yields `expiresAtMs: null`, never a
 * throw and never a false negative on the prefix.
 */
export function parseTimeoutRejection(
  message: string | null | undefined,
): TimeoutRejection | null {
  if (!message) {
    return null;
  }
  const trimmed = message.trim();
  if (!trimmed.startsWith(TIMEOUT_PREFIX)) {
    return null;
  }
  const rest = trimmed.slice(TIMEOUT_PREFIX.length).trim();
  const seconds = Number.parseInt(rest, 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return { expiresAtMs: null };
  }
  return { expiresAtMs: seconds * 1000 };
}

/**
 * True when a known timeout expiry is still in the future. A `null` expiry
 * (unknown) counts as still-active — fail closed, since the member was
 * demonstrably timed out at their last send attempt.
 */
export function isTimeoutActive(
  expiresAtMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (expiresAtMs === null) {
    return true;
  }
  return expiresAtMs > nowMs;
}

/**
 * Time left until `expiresAtMs` as a short human string for the banner:
 * `"2h 5m"`, `"3m 20s"`, `"12s"`. `null` when there is no countdown to show —
 * the expiry is unknown, or already elapsed.
 */
export function formatTimeoutRemaining(
  expiresAtMs: number | null,
  nowMs: number = Date.now(),
): string | null {
  if (expiresAtMs === null) {
    return null;
  }
  const totalSeconds = Math.ceil((expiresAtMs - nowMs) / 1000);
  if (totalSeconds <= 0) {
    return null;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
