import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLLOW_EDGE_PX,
  FOLLOW_INPUT_ARM_MS,
  FOLLOW_UPWARD_PX,
  applyInputFollowScroll,
  armFollowInput,
  createInputFollowState,
  forceInputFollow,
  isScrolledToBottom,
} from "./scrollFollow.ts";

// Scroller fixture: 800px viewport over 50000px of content, so the bottom
// sits at scrollTop 49200. Hardcoded, never derived from the engine.
const VIEWPORT = 800;
const CONTENT = 50_000;
const BOTTOM = CONTENT - VIEWPORT; // 49200
const NEAR_BOTTOM = BOTTOM - 16; // inside the 32px resume band
const READING = BOTTOM - 2_000; // comfortably reading up

test("isScrolledToBottom pins the band edges", () => {
  assert.equal(isScrolledToBottom(BOTTOM, CONTENT, VIEWPORT), true);
  assert.equal(isScrolledToBottom(NEAR_BOTTOM, CONTENT, VIEWPORT), true);
  assert.equal(isScrolledToBottom(BOTTOM - 33, CONTENT, VIEWPORT), false);
});

// The delta engine (nextFollowState) was removed 2026-09-15 (D-027): with
// AgentActivityPanel and ForumThreadView ported onto InputFollowState, no
// caller remained, and a dead export lies about the contract. The 9/13
// pause-when-reading semantics it encoded survive inside
// applyInputFollowScroll (armed + upward movement → paused).

//
// InputFollowState — the engine the virtualized timeline uses.
//

test("a virtualizer's own upward corrections never pause the tail", () => {
  // THE regression this engine exists for (Sam, iPhone, 2026-09-14): the
  // tail jumps to the bottom, then virtua's measurement corrections walk
  // the offset UPWARD. No reader input armed the engine, so following must
  // survive the whole correction cascade.
  const state = createInputFollowState(true);
  // The jump: 0 → bottom.
  assert.equal(
    applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000),
    true,
  );
  // Correction cascade: upward, downward, upward — unarmed by design.
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 40, CONTENT, VIEWPORT, 1_016),
    true,
  );
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 12, CONTENT, VIEWPORT, 1_050),
    true,
  );
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 60, CONTENT, VIEWPORT, 1_090),
    true,
  );
  assert.equal(
    applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_120),
    true,
  );
  assert.equal(state.follow, true);
});

test("an armed input followed by upward movement pauses the tail", () => {
  // The 9/13 complaint, preserved: a reader's upward drag pauses tailing so
  // a fast stream cannot erase their escape scroll by scroll.
  const state = createInputFollowState(true);
  applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000);
  armFollowInput(state, 1_100); // touchmove
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 20, CONTENT, VIEWPORT, 1_110),
    false,
  );
  // And it stays paused while they read up.
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 900, CONTENT, VIEWPORT, 1_200),
    false,
  );
});

test("arming alone pauses nothing until the input actually moves up", () => {
  // A horizontal swipe over a code block arms the engine but never moves
  // the timeline; tailing must continue through the arm.
  const state = createInputFollowState(true);
  applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000);
  armFollowInput(state, 1_050);
  // Downward re-pin of the tail while armed: still following.
  assert.equal(
    applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_060),
    true,
  );
  // And a later UNARMED-looking upward correction cannot be blamed on the
  // expired arm.
  const late = 1_050 + FOLLOW_INPUT_ARM_MS + 100;
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 50, CONTENT, VIEWPORT, late),
    true,
  );
});

test("a stale arm expires instead of pausing a later settle", () => {
  const state = createInputFollowState(true);
  applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000);
  armFollowInput(state, 2_000);
  // The input never scrolled (swipe on an inner scroller). Long after the
  // arm window, the tail's own correction passes by — it must not pause.
  const late = 2_000 + FOLLOW_INPUT_ARM_MS + 500;
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 80, CONTENT, VIEWPORT, late),
    true,
  );
});

test("scrolling back to the bottom resumes tailing", () => {
  const state = createInputFollowState(true);
  applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000);
  armFollowInput(state, 1_100);
  applyInputFollowScroll(state, BOTTOM - 2_000, CONTENT, VIEWPORT, 1_150);
  assert.equal(state.follow, false);
  // The reader scrolls back down to the very bottom — resume, regardless
  // of what armed the original pause.
  assert.equal(
    applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 2_000),
    true,
  );
  assert.equal(state.follow, true);
});

test("the resume band consumes a pending arm", () => {
  // An armed downward flick that lands at the bottom is a come-back, not a
  // pending pause: the arm must clear so a later correction cannot eat it.
  const state = createInputFollowState(true);
  applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000);
  armFollowInput(state, 1_100);
  assert.equal(
    applyInputFollowScroll(state, READING, CONTENT, VIEWPORT, 1_120),
    false,
  );
  armFollowInput(state, 1_200); // second input: scrolling back down
  assert.equal(
    applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_260),
    true,
  );
  // Unarmed upward correction afterwards: still following (arm was consumed).
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 30, CONTENT, VIEWPORT, 1_300),
    true,
  );
});

test("forceInputFollow re-arms after a pause — the own-send exception", () => {
  // Desktop parity (prepareForOwnMessage): the reader's own send always
  // re-lands the bottom, even from a paused (reading-up) state.
  const state = createInputFollowState(true);
  applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000);
  armFollowInput(state, 1_100);
  applyInputFollowScroll(state, READING, CONTENT, VIEWPORT, 1_150);
  assert.equal(state.follow, false);
  forceInputFollow(state);
  assert.equal(state.follow, true);
  // The send's tail jump then survives its own correction cascade.
  assert.equal(
    applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_200),
    true,
  );
  assert.equal(
    applyInputFollowScroll(state, BOTTOM - 45, CONTENT, VIEWPORT, 1_230),
    true,
  );
  assert.equal(state.follow, true);
});

test("sub-pixel unarmed drift is still ignored by the input engine", () => {
  const state = createInputFollowState(true);
  applyInputFollowScroll(state, BOTTOM, CONTENT, VIEWPORT, 1_000);
  // Fractional hidpi drift, unarmed: no pause, exactly like the delta engine.
  assert.equal(
    applyInputFollowScroll(
      state,
      BOTTOM - FOLLOW_UPWARD_PX,
      CONTENT,
      VIEWPORT,
      1_010,
    ),
    true,
  );
  // The band itself still matches FOLLOW_EDGE_PX.
  assert.ok(FOLLOW_EDGE_PX === 32);
});
