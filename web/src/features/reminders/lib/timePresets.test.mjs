import assert from "node:assert/strict";
import { test } from "node:test";

import {
  daysUntilNextMonday,
  nextDayAt9am,
  parseCustomDateTime,
  TIME_PRESETS,
  todayDateString,
} from "./timePresets.ts";

/**
 * A fixed local instant, built with the LOCAL Date constructor so the
 * expectations below hold in any timezone the suite runs in. 2026-03-10 is a
 * Tuesday; 08:00 is before the 9am presets roll and 22:00 is after.
 */
const TUESDAY_8AM = new Date(2026, 2, 10, 8, 0, 0, 0).getTime();
const TUESDAY_10AM = new Date(2026, 2, 10, 10, 0, 0, 0).getTime();

function seconds(date) {
  return Math.floor(date.getTime() / 1_000);
}

test("the fixture really is a Tuesday morning", () => {
  // Guard the guard: if this drifts, every expectation below is meaningless.
  assert.equal(new Date(TUESDAY_8AM).getDay(), 2);
});

test("relative presets add exactly their labelled offset", () => {
  const at = (label) =>
    TIME_PRESETS.find((preset) => preset.label === label).at(TUESDAY_8AM);
  const base = Math.floor(TUESDAY_8AM / 1_000);
  assert.equal(at("In 30 minutes"), base + 1_800);
  assert.equal(at("In 1 hour"), base + 3_600);
  assert.equal(at("In 3 hours"), base + 10_800);
});

test("nextDayAt9am(0) returns today at 9am when it is still morning", () => {
  assert.equal(
    nextDayAt9am(TUESDAY_8AM, 0),
    seconds(new Date(2026, 2, 10, 9, 0, 0, 0)),
  );
});

test("nextDayAt9am(0) rolls to tomorrow once 9am has passed", () => {
  // The rule that stops a preset returning a PAST timestamp, which would fire
  // the reminder the instant it was published.
  assert.equal(
    nextDayAt9am(TUESDAY_10AM, 0),
    seconds(new Date(2026, 2, 11, 9, 0, 0, 0)),
  );
});

test("Tomorrow at 9am is the next calendar day at 9am", () => {
  const preset = TIME_PRESETS.find((p) => p.label === "Tomorrow at 9am");
  assert.equal(
    preset.at(TUESDAY_8AM),
    seconds(new Date(2026, 2, 11, 9, 0, 0, 0)),
  );
  // And it does not collapse to "today" late in the day.
  assert.equal(
    preset.at(TUESDAY_10AM),
    seconds(new Date(2026, 2, 11, 9, 0, 0, 0)),
  );
});

test("daysUntilNextMonday never returns zero", () => {
  const MONDAY = new Date(2026, 2, 9, 8, 0, 0, 0).getTime();
  assert.equal(new Date(MONDAY).getDay(), 1);
  assert.equal(daysUntilNextMonday(MONDAY), 7);
  assert.equal(daysUntilNextMonday(TUESDAY_8AM), 6);
  const SUNDAY = new Date(2026, 2, 15, 8, 0, 0, 0).getTime();
  assert.equal(new Date(SUNDAY).getDay(), 0);
  assert.equal(daysUntilNextMonday(SUNDAY), 1);
});

test("Next Monday at 9am lands on a Monday, in the future", () => {
  const preset = TIME_PRESETS.find((p) => p.label === "Next Monday at 9am");
  const at = preset.at(TUESDAY_8AM);
  assert.equal(at, seconds(new Date(2026, 2, 16, 9, 0, 0, 0)));
  assert.equal(new Date(at * 1_000).getDay(), 1);
});

test("every preset is strictly in the future at both fixture instants", () => {
  assert.ok(TIME_PRESETS.length > 0, "there is something to check");
  for (const nowMs of [TUESDAY_8AM, TUESDAY_10AM]) {
    for (const preset of TIME_PRESETS) {
      assert.ok(
        preset.at(nowMs) > Math.floor(nowMs / 1_000),
        `${preset.label} at ${new Date(nowMs).toISOString()} is not in the future`,
      );
    }
  }
});

test("todayDateString is the local calendar date, zero-padded", () => {
  assert.equal(todayDateString(TUESDAY_8AM), "2026-03-10");
  assert.equal(
    todayDateString(new Date(2026, 0, 5, 12, 0, 0, 0).getTime()),
    "2026-01-05",
  );
});

test("parseCustomDateTime accepts a future instant", () => {
  assert.equal(
    parseCustomDateTime("2026-03-10", "18:30", TUESDAY_8AM),
    seconds(new Date(2026, 2, 10, 18, 30, 0, 0)),
  );
});

test("parseCustomDateTime rejects a time earlier today", () => {
  // The native time input has no `min`; without this guard a 07:00 pick would
  // publish a reminder that is already due.
  assert.equal(parseCustomDateTime("2026-03-10", "07:00", TUESDAY_8AM), null);
});

test("parseCustomDateTime rejects the current instant itself", () => {
  assert.equal(parseCustomDateTime("2026-03-10", "08:00", TUESDAY_8AM), null);
});

test("parseCustomDateTime rejects empty and malformed input", () => {
  assert.equal(parseCustomDateTime("", "09:00", TUESDAY_8AM), null);
  assert.equal(parseCustomDateTime("2026-03-10", "", TUESDAY_8AM), null);
  assert.equal(parseCustomDateTime("not-a-date", "09:00", TUESDAY_8AM), null);
});
