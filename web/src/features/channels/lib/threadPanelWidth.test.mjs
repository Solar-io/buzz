import assert from "node:assert/strict";
import { test } from "node:test";
import {
  THREAD_WIDTH_DEFAULT,
  THREAD_WIDTH_MIN,
  clampThreadWidth,
  parseStoredThreadWidth,
  threadWidthMax,
} from "./threadPanelWidth.ts";

test("floor: too-narrow values clamp up to the minimum", () => {
  assert.equal(clampThreadWidth(0, 1920), THREAD_WIDTH_MIN);
  assert.equal(clampThreadWidth(100, 1920), THREAD_WIDTH_MIN);
});

test("ceiling is viewport-relative, not the old fixed 640 cap", () => {
  // 1920 window: the thread may take everything but a livable channel column.
  assert.equal(threadWidthMax(1920), 1560);
  assert.equal(clampThreadWidth(2000, 1920), 1560);
  // The regression this file pins: dragging past 640 must KEEP GOING.
  assert.equal(clampThreadWidth(700, 1920), 700);
  assert.equal(clampThreadWidth(1200, 1920), 1200);
});

test("in-range values pass through unchanged", () => {
  assert.equal(clampThreadWidth(384, 1920), 384);
  assert.equal(clampThreadWidth(640, 1920), 640);
});

test("floor wins on windows too narrow for both columns", () => {
  assert.equal(threadWidthMax(500), THREAD_WIDTH_MIN);
  assert.equal(clampThreadWidth(2000, 500), THREAD_WIDTH_MIN);
});

test("stored widths parse: valid passes, junk and sub-floor reject", () => {
  assert.equal(parseStoredThreadWidth("512"), 512);
  // Above the old 640 cap is a legitimate stored value now.
  assert.equal(parseStoredThreadWidth("1048"), 1048);
  assert.equal(parseStoredThreadWidth("garbage"), null);
  assert.equal(parseStoredThreadWidth(null), null);
  assert.equal(parseStoredThreadWidth(`${THREAD_WIDTH_MIN - 1}`), null);
  assert.equal(parseStoredThreadWidth("384.7"), 384.7);
  // The fallback default is a real pane width, within [floor, old cap].
  assert.ok(
    THREAD_WIDTH_DEFAULT >= THREAD_WIDTH_MIN && THREAD_WIDTH_DEFAULT <= 640,
  );
});
