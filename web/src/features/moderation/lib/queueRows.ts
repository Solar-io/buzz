/**
 * The wire rows of the moderator-only `/moderation/*` reads, and the mapping
 * into the camelCase shapes this client uses.
 *
 * The shapes are pinned by `crates/buzz-relay/src/api/bridge.rs` —
 * `report_json` and `action_json` — not by this file. Both are NIP-98-authed
 * GETs gated on `ModerationAction::ViewQueue`, which
 * `moderation_authz::decide_authority` grants to community `owner`/`admin`
 * only: a channel role grants no queue access at all, so an ordinary member or
 * a channel moderator gets 403 rather than an empty list. That distinction
 * matters to the caller, which is why {@link isForbiddenStatus} lives here.
 *
 * Import-free by design so the node test runner can load it directly.
 */

/** `report_json` — one accepted kind:1984 report. */
export interface RawModerationReport {
  id: string;
  report_event_id: string;
  reporter_pubkey: string;
  target_kind: "event" | "pubkey" | "blob";
  target: string;
  channel_id: string | null;
  report_type: string;
  note: string | null;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  action_id: string | null;
  created_at: string;
}

/** `action_json` — one row of the moderation audit log. */
export interface RawModerationAction {
  id: string;
  actor_pubkey: string;
  action: string;
  target_pubkey: string | null;
  target_event_id: string | null;
  channel_id: string | null;
  reason_code: string | null;
  public_reason: string | null;
  private_reason: string | null;
  matched_principal: string | null;
  created_at: string;
}

/** What a report points at (`report_json.target_kind`). */
export type ReportTargetKind = "event" | "pubkey" | "blob";

/**
 * Report lifecycle status (the DB CHECK on `moderation_reports.status`).
 * `open` is the only actionable state — the relay's `handle_resolve` refuses
 * anything else with "report is not open (already resolved or dismissed)".
 */
export type ReportStatus = "open" | "resolved" | "dismissed" | "escalated";

export interface ModerationReport {
  id: string;
  /** The signed kind-1984 event id — the `report` tag a 9044 must carry. */
  reportEventId: string;
  reporterPubkey: string;
  targetKind: ReportTargetKind;
  target: string;
  channelId: string | null;
  reportType: string;
  note: string | null;
  status: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  actionId: string | null;
  createdAt: string;
}

export interface ModerationAuditAction {
  id: string;
  actorPubkey: string;
  action: string;
  targetPubkey: string | null;
  targetEventId: string | null;
  channelId: string | null;
  reasonCode: string | null;
  publicReason: string | null;
  privateReason: string | null;
  matchedPrincipal: string | null;
  createdAt: string;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function lowerOrNull(value: string | null): string | null {
  return value === null ? null : lower(value);
}

/**
 * Map one report row.
 *
 * Hex identifiers are lowercased because everything downstream compares them:
 * the reported event id against the ids of events fetched back from the relay,
 * the reporter pubkey against a profile map's keys, the target against the
 * audit log's `target_pubkey`. The relay emits lowercase hex today
 * (`hex::encode`), so this is a guard against a future emitter rather than a
 * fix for a live bug — but a case-sensitive comparison that silently finds
 * nothing is exactly the failure that looks like "no prior actions".
 */
export function reportFromRow(row: RawModerationReport): ModerationReport {
  return {
    id: row.id,
    reportEventId: lower(row.report_event_id),
    reporterPubkey: lower(row.reporter_pubkey),
    targetKind: row.target_kind,
    target: lower(row.target),
    channelId: row.channel_id,
    reportType: row.report_type,
    note: row.note,
    status: row.status,
    resolvedBy: lowerOrNull(row.resolved_by),
    resolvedAt: row.resolved_at,
    actionId: row.action_id,
    createdAt: row.created_at,
  };
}

/** Map one audit row. */
export function auditActionFromRow(
  row: RawModerationAction,
): ModerationAuditAction {
  return {
    id: row.id,
    actorPubkey: lower(row.actor_pubkey),
    action: row.action,
    targetPubkey: lowerOrNull(row.target_pubkey),
    targetEventId: lowerOrNull(row.target_event_id),
    channelId: row.channel_id,
    reasonCode: row.reason_code,
    publicReason: row.public_reason,
    privateReason: row.private_reason,
    matchedPrincipal: row.matched_principal,
    createdAt: row.created_at,
  };
}

/**
 * True for the status the relay uses to say "you are not a moderator here".
 *
 * `authorize_moderation_read` maps every authorization failure to 403 with
 * "restricted: moderator access required"; a 401 means the NIP-98 header
 * itself was rejected, which is a different failure and must not read as "not
 * a moderator" — the caller shows that one as an error, not as the gate.
 */
export function isForbiddenStatus(status: number): boolean {
  return status === 403;
}
