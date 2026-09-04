import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModerationQueue,
  groupTopReportType,
  openReports,
  reportSeverity,
  reportTypeLabel,
  severityTier,
  targetKey,
} from "./queue.ts";

/** A report row, already mapped. Only the fields the triage math reads. */
function report(overrides = {}) {
  return {
    id: "r1",
    reportEventId: "aa".repeat(32),
    reporterPubkey: "bb".repeat(32),
    targetKind: "event",
    target: "cc".repeat(32),
    channelId: "11111111-2222-3333-4444-555555555555",
    reportType: "spam",
    note: null,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    actionId: null,
    createdAt: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

function auditAction(overrides = {}) {
  return {
    id: "a1",
    actorPubkey: "dd".repeat(32),
    action: "ban",
    targetPubkey: null,
    targetEventId: null,
    channelId: null,
    reasonCode: null,
    publicReason: null,
    privateReason: null,
    matchedPrincipal: null,
    createdAt: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

/**
 * Ranks are asserted as ORDER, not as the literal numbers: the numbers are an
 * implementation detail of the comparator, while the order is the product
 * decision (illegal routes to the platform-safety lane, so it acts first).
 */
test("severity ranks illegal above malware above spam above other", () => {
  assert.ok(reportSeverity("illegal") > reportSeverity("malware"));
  assert.ok(reportSeverity("malware") > reportSeverity("impersonation"));
  assert.ok(reportSeverity("impersonation") > reportSeverity("nudity"));
  assert.ok(reportSeverity("nudity") > reportSeverity("spam"));
  assert.ok(reportSeverity("spam") > reportSeverity("profanity"));
  assert.ok(reportSeverity("profanity") > reportSeverity("other"));
});

test("an unknown category sinks to the bottom rather than sorting on NaN", () => {
  assert.equal(reportSeverity("cryptocurrency"), reportSeverity("other"));
  assert.equal(reportTypeLabel("cryptocurrency"), "cryptocurrency");
  assert.equal(severityTier("cryptocurrency"), "normal");
});

test("severity tiers separate illegal from malware from the rest", () => {
  assert.equal(severityTier("illegal"), "critical");
  assert.equal(severityTier("malware"), "high");
  assert.equal(severityTier("impersonation"), "high");
  assert.equal(severityTier("spam"), "normal");
});

test("target keys are kind-qualified, so an id cannot collide with a pubkey", () => {
  const shared = "ee".repeat(32);
  assert.notEqual(
    targetKey(report({ targetKind: "event", target: shared })),
    targetKey(report({ targetKind: "pubkey", target: shared })),
  );
});

test("reports about one target collapse into one group, newest report first", () => {
  const groups = buildModerationQueue([
    report({ id: "r1", createdAt: "2026-09-01T10:00:00Z" }),
    report({ id: "r2", createdAt: "2026-09-03T10:00:00Z" }),
    report({ id: "r3", createdAt: "2026-09-02T10:00:00Z" }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].reports.map((r) => r.id),
    ["r2", "r3", "r1"],
  );
  assert.equal(groups[0].latestCreatedAt, "2026-09-03T10:00:00Z");
});

/**
 * The ordering test that discriminates: the SPAM group is newer, so a
 * comparator that only looked at time would put it first. Severity has to win,
 * and only then time.
 */
test("groups sort by severity first and recency second", () => {
  const groups = buildModerationQueue([
    report({
      id: "spam-new",
      target: "11".repeat(32),
      reportType: "spam",
      createdAt: "2026-09-09T10:00:00Z",
    }),
    report({
      id: "illegal-old",
      target: "22".repeat(32),
      reportType: "illegal",
      createdAt: "2026-09-01T10:00:00Z",
    }),
    report({
      id: "spam-older",
      target: "33".repeat(32),
      reportType: "spam",
      createdAt: "2026-09-05T10:00:00Z",
    }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.reports[0].id),
    ["illegal-old", "spam-new", "spam-older"],
  );
});

test("a group wears the most severe badge among its reports", () => {
  const groups = buildModerationQueue([
    report({ id: "r1", reportType: "spam" }),
    report({ id: "r2", reportType: "malware" }),
    report({ id: "r3", reportType: "profanity" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groupTopReportType(groups[0]), "malware");
  assert.equal(groups[0].maxSeverity, reportSeverity("malware"));
});

/**
 * Prior actions correlate on the column that matches the target KIND. The
 * fixture deliberately gives the pubkey row and the event row the same hex, so
 * a matcher that ignored the kind would attach both to both.
 */
test("prior actions attach to the target of the matching kind only", () => {
  const shared = "44".repeat(32);
  const groups = buildModerationQueue(
    [
      report({ id: "ev", targetKind: "event", target: shared }),
      report({
        id: "pk",
        targetKind: "pubkey",
        target: shared,
        channelId: null,
      }),
    ],
    [
      auditAction({ id: "by-event", targetEventId: shared }),
      auditAction({ id: "by-pubkey", targetPubkey: shared }),
    ],
  );
  const eventGroup = groups.find((g) => g.targetKind === "event");
  const pubkeyGroup = groups.find((g) => g.targetKind === "pubkey");
  assert.deepEqual(
    eventGroup.priorActions.map((a) => a.id),
    ["by-event"],
  );
  assert.deepEqual(
    pubkeyGroup.priorActions.map((a) => a.id),
    ["by-pubkey"],
  );
});

test("a blob group surfaces no prior actions — the audit shape has no column", () => {
  const shared = "55".repeat(32);
  const groups = buildModerationQueue(
    [report({ targetKind: "blob", target: shared, channelId: null })],
    [
      auditAction({ targetEventId: shared }),
      auditAction({ targetPubkey: shared }),
    ],
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].priorActions.length, 0);
});

test("prior actions come back newest first", () => {
  const target = "66".repeat(32);
  const groups = buildModerationQueue(
    [report({ target })],
    [
      auditAction({
        id: "old",
        targetEventId: target,
        createdAt: "2026-08-01T00:00:00Z",
      }),
      auditAction({
        id: "new",
        targetEventId: target,
        createdAt: "2026-08-20T00:00:00Z",
      }),
    ],
  );
  assert.deepEqual(
    groups[0].priorActions.map((a) => a.id),
    ["new", "old"],
  );
});

/**
 * A group can be assembled from reports that disagree about the channel — a
 * pubkey-target report carries none. Losing the channel to ordering luck would
 * silently disable the channel-scoped resolutions on the whole group.
 */
test("a group keeps the first channel any of its reports supplied", () => {
  const target = "77".repeat(32);
  const channel = "99999999-8888-7777-6666-555555555555";
  const groups = buildModerationQueue([
    report({ id: "r1", target, channelId: null, createdAt: "2026-09-02" }),
    report({ id: "r2", target, channelId: channel, createdAt: "2026-09-01" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].channelId, channel);
});

test("openReports returns only the rows a resolve can still close", () => {
  const groups = buildModerationQueue([
    report({ id: "r1", status: "open" }),
    report({ id: "r2", status: "resolved" }),
    report({ id: "r3", status: "escalated" }),
  ]);
  assert.deepEqual(
    openReports(groups[0]).map((r) => r.id),
    ["r1"],
  );
});

test("an empty queue is an empty array, not a group of nothing", () => {
  assert.deepEqual(buildModerationQueue([], []), []);
});
