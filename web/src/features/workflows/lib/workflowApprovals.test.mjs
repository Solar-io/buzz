import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalEventTemplate,
  approvalsFromJson,
  approvalFromJson,
  canApprove,
  isActionable,
  isExpired,
  KIND_APPROVAL_DENY,
  KIND_APPROVAL_GRANT,
} from "./workflowApprovals.ts";

const REF = "ab".repeat(32);
const VIEWER = "11".repeat(32);
const OTHER = "22".repeat(32);

/** Shaped as `approval_json` in crates/buzz-relay/src/api/workflows.rs. */
function relayBody(overrides = {}) {
  return {
    approvals: [
      {
        approval_ref: REF,
        workflow_id: "4f1c8b6a-2d31-4a55-9c0e-7b8d5e2f1a90",
        run_id: "11111111-1111-4111-8111-111111111111",
        step_id: "page",
        step_index: 1,
        approver_spec: "any",
        status: "pending",
        approver_pubkey: null,
        note: null,
        expires_at: "2999-01-01T00:00:00Z",
        created_at: 1_700_000_000,
        ...overrides,
      },
    ],
  };
}

test("parses the relay's approvals body", () => {
  const [approval] = approvalsFromJson(relayBody());
  assert.equal(approval.approvalRef, REF);
  assert.equal(approval.stepId, "page");
  assert.equal(approval.stepIndex, 1);
  assert.equal(approval.approverSpec, "any");
  assert.equal(approval.status, "pending");
  assert.equal(approval.expiresAt, "2999-01-01T00:00:00Z");
  assert.equal(approval.createdAt, 1_700_000_000);
});

test("drops a row with no approval_ref — it cannot be acted on", () => {
  assert.equal(approvalFromJson({ workflow_id: "x", run_id: "y" }), null);
  assert.deepEqual(approvalsFromJson({}), []);
  assert.deepEqual(approvalsFromJson(null), []);
});

test("falls back to pending for a status the relay has not defined", () => {
  const [approval] = approvalsFromJson(relayBody({ status: "sideways" }));
  assert.equal(approval.status, "pending");
});

test("mirrors the relay's approver spec rules exactly", () => {
  // crates/buzz-relay/src/handlers/command_executor.rs — check_approver_spec.
  assert.equal(canApprove("", VIEWER), true, "empty admits anyone");
  assert.equal(canApprove("any", VIEWER), true);
  assert.equal(canApprove("  any  ", VIEWER), true);
  assert.equal(canApprove(VIEWER, VIEWER), true, "exact pubkey admits itself");
  assert.equal(
    canApprove(VIEWER.toUpperCase(), VIEWER),
    true,
    "the relay compares case-insensitively",
  );
  assert.equal(
    canApprove(OTHER, VIEWER),
    false,
    "a different pubkey is refused",
  );
  assert.equal(
    canApprove("role:admin", VIEWER),
    false,
    "an unrecognised spec fails closed, as the relay does",
  );
  assert.equal(
    canApprove("any", null),
    false,
    "a signed-out viewer cannot act",
  );
});

test("an elapsed window is expired and not actionable", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const [live] = approvalsFromJson(relayBody());
  assert.equal(isExpired(live, now), false);
  assert.equal(isActionable(live, VIEWER, now), true);

  const [stale] = approvalsFromJson(
    relayBody({ expires_at: "2025-01-01T00:00:00Z" }),
  );
  assert.equal(isExpired(stale, now), true);
  assert.equal(isActionable(stale, VIEWER, now), false);
});

test("an already-decided approval is not actionable", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  for (const status of ["granted", "denied", "expired"]) {
    const [approval] = approvalsFromJson(relayBody({ status }));
    assert.equal(
      isActionable(approval, VIEWER, now),
      false,
      `${status} must not be actionable`,
    );
  }
});

test("builds the grant and deny events the relay actually reads", () => {
  // handle_approval_grant reads the `d` tag, hex-decodes it and looks the
  // approval up by that stored hash — so approval_ref goes in verbatim.
  const grant = approvalEventTemplate(REF, true, "  looks fine  ");
  assert.equal(grant.kind, KIND_APPROVAL_GRANT);
  assert.equal(grant.kind, 46030);
  assert.deepEqual(grant.tags, [["d", REF]]);
  assert.equal(grant.content, "looks fine");

  const deny = approvalEventTemplate(REF, false);
  assert.equal(deny.kind, KIND_APPROVAL_DENY);
  assert.equal(deny.kind, 46031);
  assert.deepEqual(deny.tags, [["d", REF]]);
  assert.equal(deny.content, "");
});

test("lowercases the reference so the relay's hex decode succeeds", () => {
  const grant = approvalEventTemplate(REF.toUpperCase(), true);
  assert.deepEqual(grant.tags, [["d", REF]]);
});

test("refuses a reference that is not a 64-character hex digest", () => {
  assert.throws(() => approvalEventTemplate("not-a-hash", true), /hex digest/);
  assert.throws(
    () => approvalEventTemplate("ab".repeat(31), true),
    /hex digest/,
  );
  assert.throws(() => approvalEventTemplate(`${REF}ff`, true), /hex digest/);
});
