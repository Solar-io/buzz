import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_EDGE_PX, isScrolledToBottom } from "./scrollFollow.ts";

test("at-bottom detection tolerates sub-pixel drift but not real distance", () => {
  // Hardcoded geometry: 1000px of content in a 400px viewport → bottom at 600.
  assert.equal(isScrolledToBottom(600, 1000, 400), true); // exactly at bottom
  assert.equal(isScrolledToBottom(599.5, 1000, 400), true); // rounding drift
  assert.equal(isScrolledToBottom(568.01, 1000, 400), true); // just inside 32px
  assert.equal(isScrolledToBottom(568, 1000, 400), true); // exactly 32px away
  assert.equal(isScrolledToBottom(567.99, 1000, 400), false); // 32.01px away
  // The reading position: a screen and a half up.
  assert.equal(isScrolledToBottom(100, 1000, 400), false);
});

test("short content that cannot scroll counts as at-bottom", () => {
  assert.equal(isScrolledToBottom(0, 300, 400), true);
  assert.equal(isScrolledToBottom(0, 0, 0), true);
  // Equal heights → distance 0 → following.
  assert.equal(isScrolledToBottom(0, 400, 400), true);
});

test("edge tolerance is 32px (the pause threshold users feel)", () => {
  assert.equal(FOLLOW_EDGE_PX, 32);
});
