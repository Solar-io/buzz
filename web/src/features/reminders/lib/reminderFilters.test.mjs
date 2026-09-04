import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countDue,
  dueSince,
  endOfLocalDay,
  formatDueLabel,
  groupReminders,
  isDue,
  pendingTargetEventIds,
} from "./reminderFilters.ts";

/**
 * Every expectation in here is a HARDCODED instant, never one derived from
 * the value it is pinning. `NOW` is a fixed second; `NOW - 1` and `NOW + 1`
 * are the two sides of the due boundary, and the assertions say which side
 * each fixture is on rather than restating the comparison under test.
 */
const NOW = 1_800_000_000;

function reminder(overrides = {}) {
  return {
    id: overrides.id ?? "d1",
    notBefore: overrides.notBefore,
    createdAt: overrides.createdAt ?? 1_700_000_000,
    eventId: overrides.eventId ?? "e1",
    content: {
      status: overrides.status ?? "pending",
      note: overrides.note ?? "remember this",
      target: overrides.target,
    },
  };
}

test("isDue is true exactly at not_before and false one second before", () => {
  assert.equal(isDue(reminder({ notBefore: NOW }), NOW), true);
  assert.equal(isDue(reminder({ notBefore: NOW - 1 }), NOW), true);
  assert.equal(isDue(reminder({ notBefore: NOW + 1 }), NOW), false);
});

test("isDue refuses a terminal reminder even when not_before is past", () => {
  // NIP-ER: a done/cancelled head must never be scheduled or notified, even
  // if some client wrongly left not_before on it.
  assert.equal(
    isDue(reminder({ notBefore: NOW - 3600, status: "done" }), NOW),
    false,
  );
  assert.equal(
    isDue(reminder({ notBefore: NOW - 3600, status: "cancelled" }), NOW),
    false,
  );
});

test("isDue refuses a pending reminder with no not_before (a bookmark)", () => {
  assert.equal(isDue(reminder({ notBefore: undefined }), NOW), false);
});

test("countDue counts only the due ones", () => {
  const reminders = [
    reminder({ id: "a", notBefore: NOW - 10 }),
    reminder({ id: "b", notBefore: NOW + 10 }),
    reminder({ id: "c", notBefore: NOW - 10, status: "done" }),
    reminder({ id: "d", notBefore: NOW }),
  ];
  assert.equal(countDue(reminders, NOW), 2);
});

test("dueSince is exclusive at the watermark and inclusive at now", () => {
  const watermark = NOW - 100;
  const reminders = [
    // AT the watermark: already had its chance, must not re-fire.
    reminder({ id: "at-watermark", notBefore: watermark }),
    // One second after: newly due.
    reminder({ id: "just-after", notBefore: watermark + 1 }),
    // Exactly now: due.
    reminder({ id: "now", notBefore: NOW }),
    // One second out: not yet.
    reminder({ id: "future", notBefore: NOW + 1 }),
  ];
  const fired = dueSince(reminders, watermark, NOW).map((r) => r.id);
  assert.deepEqual(fired, ["just-after", "now"]);
});

test("dueSince never replays history seeded at the watermark", () => {
  // First launch seeds watermark = now. A reminder that came due a week ago
  // must produce no alert at all.
  const old = reminder({ id: "ancient", notBefore: NOW - 604_800 });
  assert.deepEqual(dueSince([old], NOW, NOW), []);
});

test("dueSince ignores terminal reminders in the window", () => {
  const watermark = NOW - 100;
  const reminders = [
    reminder({ id: "done", notBefore: watermark + 5, status: "done" }),
    reminder({
      id: "cancelled",
      notBefore: watermark + 5,
      status: "cancelled",
    }),
    reminder({ id: "pending", notBefore: watermark + 5 }),
  ];
  assert.deepEqual(
    dueSince(reminders, watermark, NOW).map((r) => r.id),
    ["pending"],
  );
});

test("endOfLocalDay lands on the last second of the same local day", () => {
  const end = endOfLocalDay(NOW);
  const endDate = new Date(end * 1_000);
  const nowDate = new Date(NOW * 1_000);
  assert.equal(endDate.getDate(), nowDate.getDate());
  assert.equal(endDate.getHours(), 23);
  assert.equal(endDate.getMinutes(), 59);
  assert.equal(endDate.getSeconds(), 59);
  assert.ok(end >= NOW, "end of day is never before now");
});

test("groupReminders buckets overdue, today and upcoming", () => {
  const endToday = endOfLocalDay(NOW);
  const reminders = [
    reminder({ id: "overdue", notBefore: NOW - 60 }),
    reminder({ id: "today", notBefore: endToday - 1 }),
    reminder({ id: "tomorrow", notBefore: endToday + 60 }),
  ];
  const groups = groupReminders(reminders, NOW);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["Overdue", "Today", "Upcoming"],
  );
  assert.deepEqual(
    groups.map((group) => group.reminders.map((r) => r.id)),
    [["overdue"], ["today"], ["tomorrow"]],
  );
});

test("groupReminders omits empty buckets", () => {
  const groups = groupReminders([reminder({ notBefore: NOW - 1 })], NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Overdue");
});

test("groupReminders never surfaces cancelled reminders", () => {
  const groups = groupReminders(
    [reminder({ id: "gone", notBefore: NOW - 1, status: "cancelled" })],
    NOW,
    { includeDone: true },
  );
  assert.deepEqual(groups, []);
});

test("groupReminders shows completed only when asked", () => {
  const done = [reminder({ id: "done", status: "done", notBefore: undefined })];
  assert.deepEqual(groupReminders(done, NOW), []);
  const withDone = groupReminders(done, NOW, { includeDone: true });
  assert.deepEqual(
    withDone.map((group) => group.label),
    ["Completed"],
  );
});

test("groupReminders orders each pending bucket soonest first", () => {
  const reminders = [
    reminder({ id: "later", notBefore: NOW - 10 }),
    reminder({ id: "earlier", notBefore: NOW - 100 }),
  ];
  const [overdue] = groupReminders(reminders, NOW);
  assert.deepEqual(
    overdue.reminders.map((r) => r.id),
    ["earlier", "later"],
  );
});

test("pendingTargetEventIds collects only pending targets", () => {
  const ids = pendingTargetEventIds([
    reminder({
      id: "a",
      target: { eventId: "m1", channelId: "c", preview: "", authorPubkey: "p" },
    }),
    reminder({
      id: "b",
      status: "done",
      target: { eventId: "m2", channelId: "c", preview: "", authorPubkey: "p" },
    }),
    reminder({ id: "c" }),
  ]);
  assert.deepEqual([...ids], ["m1"]);
});

test("formatDueLabel says overdue for the past and in-N for the future", () => {
  assert.equal(formatDueLabel(NOW - 30, NOW), "just now");
  assert.equal(formatDueLabel(NOW - 600, NOW), "10m overdue");
  assert.equal(formatDueLabel(NOW - 7_200, NOW), "2h overdue");
  assert.equal(formatDueLabel(NOW - 172_800, NOW), "2d overdue");
  assert.equal(formatDueLabel(NOW + 30, NOW), "in less than a minute");
  assert.equal(formatDueLabel(NOW + 900, NOW), "in 15m");
  assert.equal(formatDueLabel(NOW + 10_800, NOW), "in 3h");
  assert.equal(formatDueLabel(NOW + 259_200, NOW), "in 3d");
});
