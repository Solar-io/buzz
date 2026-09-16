import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetChannel, markSeen, isUnread } from "./readState.ts";

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

test("forgetChannel drops one marker (delete-flow eviction)", () => {
  const state = { ch1: 100, ch2: 200 };
  const next = forgetChannel(state, "ch1");
  assert.equal(next.ch1, undefined, "deleted channel's marker is gone");
  assert.equal(next.ch2, 200, "other markers survive");
  assert.equal(state.ch1, 100, "input state is not mutated");
});

test("forgetChannel on an absent channel returns the same state", () => {
  const state = { ch1: 100 };
  assert.equal(forgetChannel(state, "missing"), state);
});
