/**
 * Workflow approvals: reading pending gates and acting on one.
 *
 * READ — `GET /workflows/{workflow_id}/runs/{run_id}/approvals`
 * (`crates/buzz-relay/src/router.rs`), serialized by `approval_json` in
 * `crates/buzz-relay/src/api/workflows.rs`. The wire field is `approval_ref`,
 * and it is the hex of the *stored hash* of the approval token, never the
 * token itself — the relay has a test pinning exactly that
 * (`approval_wire_does_not_expose_hash_as_token`).
 *
 * ACT — a signed event, kind 46030 to grant or 46031 to deny
 * (`KIND_APPROVAL_GRANT` / `KIND_APPROVAL_DENY`), carrying the hash hex in its
 * `d` tag and an optional note as content. The relay's `handle_approval_grant`
 * reads `d` (or `e`), hex-decodes it, and looks the approval up by that stored
 * hash — so `approval_ref` goes into the `d` tag verbatim, with no further
 * hashing. `buzz-cli` hashes because it starts from the raw token UUID a user
 * typed; a client reading `approval_ref` already holds the hash.
 *
 * NOTE — Buzz Desktop's builder is not this shape. It puts the raw token in a
 * `t` tag (`desktop/src-tauri/src/events/workflows.rs`), which the relay does
 * not read; such an event is rejected with "missing approval reference (d or e
 * tag)". Its UI says approval actions are unavailable, which is consistent.
 */

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired";

export type WorkflowApproval = {
  /** Hex of the stored token hash — the `d` tag of a grant or deny event. */
  approvalRef: string;
  workflowId: string;
  runId: string;
  stepId: string;
  stepIndex: number;
  /** "", "any", or a 64-char pubkey hex. See `check_approver_spec`. */
  approverSpec: string;
  status: ApprovalStatus;
  approverPubkey: string | null;
  note: string | null;
  /** RFC 3339 timestamp, verbatim from the relay. */
  expiresAt: string | null;
  createdAt: number;
};

const APPROVAL_STATUSES = new Set(["pending", "granted", "denied", "expired"]);

/** Kind 46030 — grant a pending approval. */
export const KIND_APPROVAL_GRANT = 46030;
/** Kind 46031 — deny a pending approval. */
export const KIND_APPROVAL_DENY = 46031;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function approvalFromJson(value: unknown): WorkflowApproval | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const approvalRef = asString(raw.approval_ref);
  const workflowId = asString(raw.workflow_id);
  const runId = asString(raw.run_id);
  if (approvalRef === null || workflowId === null || runId === null) {
    return null;
  }
  const status = asString(raw.status);
  return {
    approvalRef,
    workflowId,
    runId,
    stepId: asString(raw.step_id) ?? "",
    stepIndex: typeof raw.step_index === "number" ? raw.step_index : 0,
    approverSpec:
      typeof raw.approver_spec === "string" ? raw.approver_spec : "",
    status:
      status !== null && APPROVAL_STATUSES.has(status)
        ? (status as ApprovalStatus)
        : "pending",
    approverPubkey: asString(raw.approver_pubkey),
    note: asString(raw.note),
    expiresAt: asString(raw.expires_at),
    createdAt: typeof raw.created_at === "number" ? raw.created_at : 0,
  };
}

/** Parse a whole approvals response body. */
export function approvalsFromJson(body: unknown): WorkflowApproval[] {
  const raw = asRecord(body);
  const rows =
    raw !== null && Array.isArray(raw.approvals) ? raw.approvals : [];
  return rows
    .map(approvalFromJson)
    .filter((approval): approval is WorkflowApproval => approval !== null);
}

const PUBKEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Whether `viewerPubkey` may act on this approval, mirroring the relay's
 * `check_approver_spec` (`crates/buzz-relay/src/handlers/command_executor.rs`)
 * so the UI never offers a button the relay will refuse: empty or "any" admits
 * any authenticated user, a 64-char hex admits only that pubkey (case
 * insensitively), and every other spec fails closed.
 */
export function canApprove(
  approverSpec: string,
  viewerPubkey: string | null,
): boolean {
  if (viewerPubkey === null || viewerPubkey === "") return false;
  const spec = approverSpec.trim();
  if (spec === "" || spec === "any") return true;
  if (PUBKEY_HEX.test(spec)) {
    return spec.toLowerCase() === viewerPubkey.toLowerCase();
  }
  return false;
}

/** True once the approval window has elapsed; an expired gate is not actionable. */
export function isExpired(
  approval: WorkflowApproval,
  now: number = Date.now(),
): boolean {
  if (approval.expiresAt === null) return false;
  const expires = Date.parse(approval.expiresAt);
  return Number.isFinite(expires) && expires <= now;
}

/** An approval is actionable only while it is pending and unexpired. */
export function isActionable(
  approval: WorkflowApproval,
  viewerPubkey: string | null,
  now: number = Date.now(),
): boolean {
  return (
    approval.status === "pending" &&
    !isExpired(approval, now) &&
    canApprove(approval.approverSpec, viewerPubkey)
  );
}

export type ApprovalEventTemplate = {
  kind: number;
  tags: string[][];
  content: string;
};

const HASH_HEX = /^[0-9a-f]{64}$/i;

/**
 * Build the unsigned grant or deny event for an approval.
 *
 * Throws on a reference that is not a 64-character hex digest: the relay
 * hex-decodes the `d` tag before its lookup, so anything else is a request
 * that cannot succeed, and failing here says why instead of surfacing the
 * relay's generic "approval not found".
 */
export function approvalEventTemplate(
  approvalRef: string,
  approved: boolean,
  note?: string,
): ApprovalEventTemplate {
  if (!HASH_HEX.test(approvalRef)) {
    throw new Error("Approval reference must be a 64-character hex digest.");
  }
  return {
    kind: approved ? KIND_APPROVAL_GRANT : KIND_APPROVAL_DENY,
    tags: [["d", approvalRef.toLowerCase()]],
    content: note?.trim() ?? "",
  };
}
