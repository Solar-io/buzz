import assert from "node:assert/strict";
import test from "node:test";

import {
  auditActionFromRow,
  isForbiddenStatus,
  reportFromRow,
} from "./queueRows.ts";

/**
 * Row mapping. The interesting behaviour is not the renaming — it is the
 * lowercasing, because every downstream comparison is `===` against a hex
 * string that came from somewhere else (an event id off the socket, an audit
 * row's `target_pubkey`), and a case mismatch there fails silently as "no
 * prior actions" or "author unknown".
 */

const REPORT_ROW = {
  id: "row-1",
  report_event_id: "AB".repeat(32),
  reporter_pubkey: "CD".repeat(32),
  target_kind: "event",
  target: "EF".repeat(32),
  channel_id: "11111111-2222-3333-4444-555555555555",
  report_type: "spam",
  note: "  keeps posting links  ",
  status: "open",
  resolved_by: null,
  resolved_at: null,
  action_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

test("a report row lowercases every hex identifier it carries", () => {
  const report = reportFromRow(REPORT_ROW);
  assert.equal(report.reportEventId, "ab".repeat(32));
  assert.equal(report.reporterPubkey, "cd".repeat(32));
  assert.equal(report.target, "ef".repeat(32));
  // Not hex, and not ours to normalize: the channel id is a UUID the relay
  // round-trips, and the note is the reporter's own words.
  assert.equal(report.channelId, "11111111-2222-3333-4444-555555555555");
  assert.equal(report.note, "  keeps posting links  ");
  assert.equal(report.targetKind, "event");
  assert.equal(report.status, "open");
});

test("a resolved report keeps its resolver and drops nothing", () => {
  const report = reportFromRow({
    ...REPORT_ROW,
    status: "resolved",
    resolved_by: "99".repeat(32),
    resolved_at: "2026-09-02T10:00:00Z",
    action_id: "action-7",
  });
  assert.equal(report.resolvedBy, "99".repeat(32));
  assert.equal(report.resolvedAt, "2026-09-02T10:00:00Z");
  assert.equal(report.actionId, "action-7");
});

test("an audit row lowercases both target columns and keeps nulls null", () => {
  const action = auditActionFromRow({
    id: "audit-1",
    actor_pubkey: "1A".repeat(32),
    action: "resolve:ban",
    target_pubkey: "2B".repeat(32),
    target_event_id: null,
    channel_id: null,
    reason_code: null,
    public_reason: "Repeated spam",
    private_reason: null,
    matched_principal: null,
    created_at: "2026-09-01T11:00:00Z",
  });
  assert.equal(action.actorPubkey, "1a".repeat(32));
  assert.equal(action.targetPubkey, "2b".repeat(32));
  assert.equal(action.targetEventId, null);
  assert.equal(action.publicReason, "Repeated spam");
  // The prefix is meaning, not noise: `resolve:ban` is the decision row and a
  // bare `ban` is the enforcement. Never collapse them.
  assert.equal(action.action, "resolve:ban");
});

/**
 * 403 is the relay's moderator gate (`authorize_moderation_read` maps every
 * authorization failure to it). 401 is a rejected NIP-98 header and 500 is a
 * broken relay; showing either as "you are not a moderator" would send a real
 * moderator away with the wrong explanation.
 */
test("only 403 reads as the moderator gate", () => {
  assert.equal(isForbiddenStatus(403), true);
  assert.equal(isForbiddenStatus(401), false);
  assert.equal(isForbiddenStatus(404), false);
  assert.equal(isForbiddenStatus(500), false);
});
