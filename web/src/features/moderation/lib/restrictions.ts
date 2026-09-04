/**
 * The moderator's view of who is currently banned or timed out.
 *
 * Source: `GET /moderation/restricted` (`api/bridge.rs::moderation_restricted`),
 * NIP-98-authed and gated on `ModerationAction::ViewQueue` — so only a
 * community owner/admin can read it, which is exactly the set of viewers this
 * client shows ban/timeout controls to. It has no WebSocket equivalent; the
 * restriction tables are not events.
 *
 * This module is the pure half — row mapping and the live-state predicates —
 * so the timestamp handling is directly testable. Import-free by design.
 */

/** Wire shape from `ban_json` (snake_case, RFC3339 timestamps). */
export interface RawRestriction {
  pubkey: string;
  banned: boolean;
  ban_expires_at: string | null;
  ban_reason: string | null;
  muted_until: string | null;
  mute_reason: string | null;
  actor_pubkey: string;
  updated_at: string;
}

export interface CommunityRestriction {
  pubkey: string;
  banned: boolean;
  banExpiresAt: string | null;
  banReason: string | null;
  mutedUntil: string | null;
  muteReason: string | null;
}

export function restrictionFromRow(row: RawRestriction): CommunityRestriction {
  return {
    pubkey: row.pubkey.trim().toLowerCase(),
    banned: row.banned === true,
    banExpiresAt: row.ban_expires_at,
    banReason: row.ban_reason,
    mutedUntil: row.muted_until,
    muteReason: row.mute_reason,
  };
}

/**
 * Coerce a restriction timestamp to epoch milliseconds. The wire emits
 * `DateTime<Utc>` as an RFC3339 string; a bare number is tolerated as unix
 * seconds. Absent or unparseable → `null`, so a bad value never renders a
 * phantom restriction.
 */
export function parseRestrictionTimestampMs(
  value: string | number | null | undefined,
): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value * 1000 : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True when `mutedUntil` is still in the future. Absent or unparseable is
 * *not* an active timeout — fail closed to "not timed out" so the menu offers
 * the apply action rather than stranding a member behind a phantom lift.
 */
export function isTimedOut(
  mutedUntil: string | number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const ms = parseRestrictionTimestampMs(mutedUntil);
  return ms != null && ms > nowMs;
}

/** The row for one pubkey, or null. Case-insensitive on the key. */
export function findRestriction(
  rows: readonly CommunityRestriction[] | undefined,
  pubkey: string | null | undefined,
): CommunityRestriction | null {
  if (!rows || !pubkey) {
    return null;
  }
  const key = pubkey.trim().toLowerCase();
  return rows.find((row) => row.pubkey === key) ?? null;
}
