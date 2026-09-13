import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLLOW_EDGE_PX,
  isScrolledToBottom,
  nextFollowState,
} from "./scrollFollow.ts";

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

// nextFollowState adds direction to the geometry. A tall scroller for the
// follow cases: 4000px of content in a 600px viewport. Bottom = 3400.
const H = 4000;
const VH = 600;
const bottom = H - VH;

test("following at the bottom stays following", () => {
  // A programmatic tail lands exactly at the bottom again.
  assert.equal(nextFollowState(true, bottom, bottom, H, VH), true);
});

test("ANY real upward scroll pauses, even inside the bottom tolerance", () => {
  // The trapped-reader case (Sam 2026-09-13): during a fast stream each
  // small scroll-up lands inside the 32px band, so a position-only rule
  // keeps tailing and erases the deltas one by one. Direction must pause
  // on the first one. (This test failed against a position-first
  // implementation of nextFollowState — the band outranked intent.)
  assert.equal(nextFollowState(true, bottom, bottom - 10, H, VH), false);
});

test("a large upward scroll pauses", () => {
  assert.equal(nextFollowState(true, bottom, bottom - 400, H, VH), false);
});

test("a paused reader who returns to the bottom resumes", () => {
  assert.equal(nextFollowState(false, bottom - 400, bottom, H, VH), true);
});

test("a paused reader scrolling down but short of the bottom stays paused", () => {
  // Resume is position-only: anything less than the very bottom keeps the
  // pause, so momentum downward does not silently re-enable tailing.
  assert.equal(nextFollowState(false, bottom - 400, bottom - 40, H, VH), false);
});

test("sub-pixel upward drift is noise, not reader intent", () => {
  // Rounding on hidpi can wiggle scrollTop by fractions while a
  // programmatic tail settles; that must not pause tailing.
  assert.equal(nextFollowState(true, bottom, bottom - 0.5, H, VH), true);
});

test("content growth does not resume a paused reader (no event, state carries)", () => {
  // scrollHeight grows under a paused reader: 500 new px, scrollTop is
  // unchanged, and the next scroll event (still short of the bottom)
  // keeps the pause.
  const grown = H + 500;
  const stillShort = bottom - 100;
  assert.equal(
    nextFollowState(false, stillShort, stillShort, grown, VH),
    false,
  );
});
