import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasNavigableTarget,
  reminderDestination,
} from "./reminderNavigation.ts";

const FULL = {
  eventId: "e".repeat(64),
  channelId: "chan-1",
  preview: "ship it",
  authorPubkey: "a".repeat(64),
};

test("a complete target is navigable", () => {
  assert.equal(hasNavigableTarget(FULL), true);
  assert.deepEqual(reminderDestination(FULL), {
    channelId: "chan-1",
    messageId: FULL.eventId,
  });
});

test("a note-only reminder has nowhere to go", () => {
  assert.equal(hasNavigableTarget(undefined), false);
  assert.equal(reminderDestination(undefined), null);
});

test("an EMPTY channel id is not navigable, even though the target exists", () => {
  // A spec-shaped NIP-ER target carries no channel, and the desktop's create
  // site writes `channelId ?? ""`. Both give an object that would route to
  // `/repos?c=` — the empty channel view — so presence is not enough.
  assert.equal(hasNavigableTarget({ ...FULL, channelId: "" }), false);
  assert.equal(reminderDestination({ ...FULL, channelId: "" }), null);
});

test("an empty event id is not navigable", () => {
  assert.equal(hasNavigableTarget({ ...FULL, eventId: "" }), false);
  assert.equal(reminderDestination({ ...FULL, eventId: "" }), null);
});

test("a missing author label does NOT block navigation", () => {
  // The author is used to draw a name. A message that is perfectly reachable
  // should not be un-openable because its author is unknown.
  assert.equal(hasNavigableTarget({ ...FULL, authorPubkey: "" }), true);
  assert.deepEqual(reminderDestination({ ...FULL, authorPubkey: "" }), {
    channelId: "chan-1",
    messageId: FULL.eventId,
  });
});
