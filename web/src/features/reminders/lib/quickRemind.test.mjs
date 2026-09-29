import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QUICK_REMIND_DELAY_SECONDS,
  quickRemindConfirmation,
  quickRemindDueAt,
} from "./quickRemind.ts";

test("the + reminder delay is one day", () => {
  // Hardcoded, not 24 * 60 * 60 — pins Sam's "+1 day" independently.
  assert.equal(QUICK_REMIND_DELAY_SECONDS, 86_400);
});

test("quickRemindDueAt is exactly 24 hours after the click", () => {
  assert.equal(quickRemindDueAt(1_790_000_000_000), 1_790_086_400);
});

test("quickRemindDueAt floors sub-second clicks to whole seconds", () => {
  assert.equal(quickRemindDueAt(1_790_000_000_999), 1_790_086_400);
});

test("the confirmation says tomorrow and carries the clock time", () => {
  const text = quickRemindConfirmation(1_790_086_400);
  assert.match(text, /^Reminder set for tomorrow \d{1,2}:\d{2}/);
  const expectedTime = new Date(1_790_086_400_000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  assert.ok(text.endsWith(expectedTime), text);
});
