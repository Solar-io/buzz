import assert from "node:assert/strict";
import test from "node:test";

import { feedbackConfirmation, feedbackDueAt } from "./feedback.ts";

/** Local wall-clock instant, so the test holds in any timezone. */
function local(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

test("due is tomorrow 9:00 local, whatever the hour", () => {
  // Filed mid-afternoon: NOT 3:42 pm tomorrow (that is what +24 h would give).
  assert.equal(
    feedbackDueAt(local(2026, 9, 30, 15, 42)),
    local(2026, 10, 1, 9) / 1000,
  );
  // Filed just after midnight: still the NEXT day's 9:00, not today's.
  assert.equal(
    feedbackDueAt(local(2026, 9, 30, 0, 5)),
    local(2026, 10, 1, 9) / 1000,
  );
  // Filed at 11 pm: ten hours out, never in the past.
  assert.equal(
    feedbackDueAt(local(2026, 9, 30, 23, 0)),
    local(2026, 10, 1, 9) / 1000,
  );
});

test("the confirmation names Feedback and the local due time", () => {
  const copy = feedbackConfirmation(local(2026, 10, 1, 9) / 1000);
  assert.match(copy, /^Sent to Feedback · due tomorrow 9:00/);
});
