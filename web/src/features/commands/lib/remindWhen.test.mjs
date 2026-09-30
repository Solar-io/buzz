import assert from "node:assert/strict";
import test from "node:test";

import { parseRemindWhen, remindWhenLabel } from "./remindWhen.ts";

/** Local wall-clock instant (ms), so the test holds in any timezone. */
function local(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}
const s = (ms) => ms / 1000;

// Wednesday 30 Sep 2026, 3:42 PM local.
const NOW = local(2026, 9, 30, 15, 42);

test("30m, 2h, tomorrow and 3pm resolve to hardcoded instants; junk is null", () => {
  assert.equal(parseRemindWhen("30m", NOW).at, s(local(2026, 9, 30, 16, 12)));
  assert.equal(parseRemindWhen("in 2 hours", NOW).at, s(local(2026, 9, 30, 17, 42)));
  assert.equal(parseRemindWhen("1d", NOW).at, s(NOW) + 86_400);
  assert.equal(parseRemindWhen("1 week", NOW).at, s(NOW) + 604_800);
  assert.equal(parseRemindWhen("tomorrow", NOW).at, s(local(2026, 10, 1, 9)));
  assert.equal(
    parseRemindWhen("Tomorrow 3:30pm", NOW).at,
    s(local(2026, 10, 1, 15, 30)),
  );
  // 5pm has not passed: today.
  assert.equal(parseRemindWhen("5pm", NOW).at, s(local(2026, 9, 30, 17)));
  // 3pm HAS passed (it is 3:42): tomorrow, never an instant in the past.
  assert.equal(parseRemindWhen("3pm", NOW).at, s(local(2026, 10, 1, 15)));
  assert.equal(parseRemindWhen("09:15", NOW).at, s(local(2026, 10, 1, 9, 15)));
  assert.equal(parseRemindWhen("12am", NOW).at, s(local(2026, 10, 1, 0)));

  for (const junk of ["", "later", "soon", "3", "25:00", "13pm", "0m", "2 parsecs", "tomorrow noonish"]) {
    assert.equal(parseRemindWhen(junk, NOW), null, junk);
  }
});

test("a weekday is the next such day, never today", () => {
  // Wednesday → the coming Monday (5 Oct), 9:00.
  assert.equal(parseRemindWhen("monday", NOW).at, s(local(2026, 10, 5, 9)));
  assert.equal(parseRemindWhen("fri 2pm", NOW).at, s(local(2026, 10, 2, 14)));
  // Typed on a Wednesday, "wednesday" is a week out.
  assert.equal(parseRemindWhen("wednesday", NOW).at, s(local(2026, 10, 7, 9)));
});

test("every parsed instant is after now", () => {
  for (const text of ["1m", "3pm", "15:42", "tomorrow", "wed", "12am"]) {
    assert.ok(parseRemindWhen(text, NOW).at > s(NOW), text);
  }
});

test("the label says today, tomorrow, or the date", () => {
  assert.match(remindWhenLabel(s(local(2026, 9, 30, 17)), NOW), /^today 5:00/);
  assert.match(
    remindWhenLabel(s(local(2026, 10, 1, 9)), NOW),
    /^tomorrow 9:00/,
  );
  assert.match(remindWhenLabel(s(local(2026, 10, 5, 9)), NOW), /Oct 5.*9:00/);
});
