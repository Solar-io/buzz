import assert from "node:assert/strict";
import { test } from "node:test";
import { markSeen, isUnread } from "./readState.ts";

test("markSeen never moves the marker backwards", () => {
  const state = { ch1: 100 };
  assert.equal(markSeen(state, "ch1", 50), state);
  const next = markSeen(state, "ch1", 200);
  assert.equal(next.ch1, 200);
});

test("isUnread is true only when newest activity beats the marker", () => {
  const state = { ch1: 100 };
  assert.equal(isUnread(state, "ch1", 150), true);
  assert.equal(isUnread(state, "ch1", 100), false);
  assert.equal(isUnread(state, "ch2", 1), true);
});
