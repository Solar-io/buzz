import assert from "node:assert/strict";
import { test } from "node:test";

import { REMINDER_BODY_MAX, reminderAlertCopy } from "./reminderAlert.ts";

function reminder(id, content) {
  return {
    id,
    notBefore: 1,
    createdAt: 1,
    eventId: `e-${id}`,
    content: { status: "pending", ...content },
  };
}

test("no due reminders produces no alert", () => {
  assert.equal(reminderAlertCopy([]), null);
});

test("one reminder shows its note", () => {
  const copy = reminderAlertCopy([reminder("d1", { note: "call the bank" })]);
  assert.equal(copy.title, "Reminder due");
  assert.equal(copy.body, "call the bank");
  assert.equal(copy.tag, "buzz:reminder:d1");
});

test("one reminder falls back to the message preview", () => {
  const copy = reminderAlertCopy([
    reminder("d2", {
      target: {
        eventId: "e",
        channelId: "c",
        preview: "can you review this",
        authorPubkey: "p",
      },
    }),
  ]);
  assert.equal(copy.body, "can you review this");
});

test("the note wins over the preview when both are present", () => {
  const copy = reminderAlertCopy([
    reminder("d3", {
      note: "my own words",
      target: {
        eventId: "e",
        channelId: "c",
        preview: "their words",
        authorPubkey: "p",
      },
    }),
  ]);
  assert.equal(copy.body, "my own words");
});

test("a reminder with nothing to say still gets a body", () => {
  const copy = reminderAlertCopy([
    reminder("d4", {
      note: "   ",
      target: { eventId: "e", channelId: "c", preview: "", authorPubkey: "p" },
    }),
  ]);
  assert.equal(copy.body, "A reminder is waiting");
});

test("a long body is truncated with an ellipsis", () => {
  const copy = reminderAlertCopy([reminder("d5", { note: "x".repeat(500) })]);
  assert.equal(copy.body.length, REMINDER_BODY_MAX);
  assert.ok(copy.body.endsWith("…"));
});

test("whitespace is collapsed so a multi-line note reads as one line", () => {
  const copy = reminderAlertCopy([
    reminder("d6", { note: "  first\n\n  second  " }),
  ]);
  assert.equal(copy.body, "first second");
});

test("several due reminders collapse into one counted alert", () => {
  const copy = reminderAlertCopy([
    reminder("a", { note: "one" }),
    reminder("b", { note: "two" }),
    reminder("c", { note: "three" }),
  ]);
  assert.equal(copy.title, "Reminders due");
  assert.equal(copy.body, "3 reminders are due");
  assert.equal(copy.tag, "buzz:reminders");
});

test("two reminders share one OS slot, one gets its own", () => {
  const batch = reminderAlertCopy([
    reminder("a", { note: "one" }),
    reminder("b", { note: "two" }),
  ]);
  const single = reminderAlertCopy([reminder("a", { note: "one" })]);
  assert.notEqual(batch.tag, single.tag);
});
