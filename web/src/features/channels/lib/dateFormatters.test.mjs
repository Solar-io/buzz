import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatClockTime,
  formatDayLabel,
  formatFullDateTime,
  formatTime,
} from "./dateFormatters.ts";

/** 2026-04-02T14:34:00Z, read in whatever zone the test host runs in. */
const SAMPLE = Math.floor(Date.UTC(2026, 3, 2, 14, 34, 0) / 1000);

test("formatClockTime drops the AM/PM marker", () => {
  const clock = formatClockTime(SAMPLE);
  assert.match(clock, /^\d{1,2}:\d{2}$/);
  assert.doesNotMatch(clock, /AM|PM/i);
});

test("formatClockTime keeps the same hour and minute as the full label", () => {
  const clock = formatClockTime(SAMPLE);
  assert.ok(
    formatFullDateTime(SAMPLE).includes(clock),
    `${formatFullDateTime(SAMPLE)} should contain ${clock}`,
  );
});

test("formatFullDateTime spells out weekday, month, year and time", () => {
  const full = formatFullDateTime(SAMPLE);
  assert.match(full, /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, 2026 at /);
  assert.match(full, /\d{1,2}:\d{2}\s?(AM|PM)$/i);
});

test("formatDayLabel names today and yesterday relatively", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(formatDayLabel(now), "Today");
  assert.equal(formatDayLabel(now - 86_400), "Yesterday");
});

test("formatDayLabel falls back to a calendar date further back", () => {
  const label = formatDayLabel(Math.floor(Date.now() / 1000) - 10 * 86_400);
  assert.notEqual(label, "Today");
  assert.notEqual(label, "Yesterday");
  assert.match(label, /\d/);
});

test("formatTime qualifies anything older than today", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.doesNotMatch(formatTime(now), / at /);
  assert.match(formatTime(now - 86_400), /^Yesterday at /);
  assert.match(formatTime(now - 3 * 86_400), / at /);
});
