import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResolveReportEvent,
  KIND_MODERATION_RESOLVE_REPORT,
} from "./resolveReportEvent.ts";

const REPORT_ID = "ab".repeat(32);

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * The kind is asserted as a LITERAL. Writing it as
 * `KIND_MODERATION_RESOLVE_REPORT` would be an expectation phrased in terms of
 * the constant it pins, so changing the constant would change its own test.
 */
test("the resolve command is kind 9044", () => {
  assert.equal(KIND_MODERATION_RESOLVE_REPORT, 9044);
  assert.equal(
    buildResolveReportEvent({ reportEventId: REPORT_ID, action: "ban" }).kind,
    9044,
  );
});

test("a resolve carries exactly one report, status and action tag", () => {
  const event = buildResolveReportEvent({
    reportEventId: REPORT_ID,
    action: "ban",
  });
  for (const name of ["report", "status", "action"]) {
    assert.equal(
      event.tags.filter((tag) => tag[0] === name).length,
      1,
      `expected exactly one ${name} tag`,
    );
  }
  assert.equal(tagValue(event, "report"), REPORT_ID);
  assert.equal(tagValue(event, "action"), "ban");
  assert.equal(event.content, "");
});

/**
 * The status is derived, never passed in, so the pairing the relay enforces
 * cannot be violated by a caller. Both halves are asserted: dismiss →
 * dismissed, and everything else → resolved.
 */
test("the status is derived from the action, and only dismiss dismisses", () => {
  assert.equal(
    tagValue(
      buildResolveReportEvent({ reportEventId: REPORT_ID, action: "dismiss" }),
      "status",
    ),
    "dismissed",
  );
  for (const action of ["delete", "kick", "ban", "timeout", "escalate"]) {
    assert.equal(
      tagValue(
        buildResolveReportEvent({ reportEventId: REPORT_ID, action }),
        "status",
      ),
      "resolved",
      `${action} must pair with resolved`,
    );
  }
});

/**
 * A stray `h` tag makes the relay reject the command outright —
 * `is_global_only_kind` treats it as channel-scoping a community-global
 * command — so the builder must never emit one, not even when the resolution
 * it describes is about a message in a channel.
 */
test("a resolve never carries an h tag", () => {
  for (const action of ["delete", "kick", "ban", "timeout", "dismiss"]) {
    const event = buildResolveReportEvent({
      reportEventId: REPORT_ID,
      action,
      reason: "in #general",
    });
    assert.equal(
      event.tags.some((tag) => tag[0] === "h"),
      false,
      `${action} emitted an h tag`,
    );
  }
});

test("a reason is trimmed, and an empty one is omitted rather than sent blank", () => {
  const withReason = buildResolveReportEvent({
    reportEventId: REPORT_ID,
    action: "ban",
    reason: "  repeated spam  ",
  });
  assert.equal(tagValue(withReason, "reason"), "repeated spam");

  for (const reason of [undefined, "", "   "]) {
    const event = buildResolveReportEvent({
      reportEventId: REPORT_ID,
      action: "ban",
      reason,
    });
    assert.equal(
      event.tags.some((tag) => tag[0] === "reason"),
      false,
    );
  }
});

test("a malformed report id is refused here rather than by the relay", () => {
  assert.throws(
    () => buildResolveReportEvent({ reportEventId: "not-hex", action: "ban" }),
    /report event id/,
  );
  assert.throws(
    () =>
      buildResolveReportEvent({
        reportEventId: "ab".repeat(31),
        action: "ban",
      }),
    /report event id/,
  );
});

test("a mixed-case report id is normalized to lowercase hex", () => {
  const event = buildResolveReportEvent({
    reportEventId: "AB".repeat(32),
    action: "escalate",
  });
  assert.equal(tagValue(event, "report"), "ab".repeat(32));
});
