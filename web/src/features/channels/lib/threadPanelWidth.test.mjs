import assert from "node:assert/strict";
import { test } from "node:test";
import {
  THREAD_WIDTH_DEFAULT,
  THREAD_WIDTH_MIN,
  clampThreadWidth,
  paneRowStyle,
  parseStoredThreadWidth,
  portraitRailWidth,
  threadWidthMax,
} from "./threadPanelWidth.ts";

test("floor: too-narrow values clamp up to the comfort minimum on wide rows", () => {
  // 600 is Sam's ask (9/17), hardcoded per the pin rule — never derived from
  // the constant it tests.
  assert.equal(clampThreadWidth(0, 1920), 600);
  assert.equal(clampThreadWidth(100, 1920), 600);
  // The resurrection case: a stale small persisted width (min-drag 288, the
  // old 384 default) reopens at 600 on a row that can afford it.
  assert.equal(clampThreadWidth(288, 1920), 600);
  assert.equal(clampThreadWidth(384, 1920), 600);
  // …but on a row too narrow for 600 + a livable channel column, the
  // responsive minimum still governs.
  assert.equal(clampThreadWidth(288, 700), 288);
  assert.equal(clampThreadWidth(100, 700), 288);
  assert.equal(clampThreadWidth(2000, 500), THREAD_WIDTH_MIN);
});

test("iPad-width rows: the pane drags below 600 so the chat column can grow", () => {
  // Sam's iPad 9/22: 1376 viewport − ~292 sidebar = ~1084 row. The 600
  // floor pinned the pane there and left the composer ~480px wide.
  assert.equal(clampThreadWidth(400, 1084), 400);
  assert.equal(clampThreadWidth(288, 1084), 288);
  assert.equal(clampThreadWidth(100, 1084), 288);
  // Boundary: 1240 = 600 pane + 640 chat, hardcoded per the pin rule.
  assert.equal(clampThreadWidth(400, 1239), 400);
  assert.equal(clampThreadWidth(400, 1240), 600);
  // The reservation counts against the row: a 300 rail on a 1440 row leaves
  // 1140, under the comfort line.
  assert.equal(clampThreadWidth(400, 1440, 300), 400);
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
  assert.equal(clampThreadWidth(640, 1920), 640);
  assert.equal(clampThreadWidth(800, 1920), 800);
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
  // The fallback default is Sam's comfort floor, exactly (9/17: "at least
  // 600px") — not a derived range check.
  assert.equal(THREAD_WIDTH_DEFAULT, 600);
});

test("portraitRailWidth: the 0.38 pane term binds on tall viewports", () => {
  // 0.38 × 500 = 190, under the 300 cap, above the 160 floor, and the
  // height term is huge on a tall window — so 190 wins outright.
  assert.equal(portraitRailWidth(500, 2000), 190);
});

test("portraitRailWidth: the 0.75 viewport-height term binds on short viewports", () => {
  // 0.38 × 500 = 190 but 0.75 × (416 − 176) = 180 — the height term wins,
  // so the 3:4 frame (height = width ÷ 0.75… × 4/3 = 240) fits 416 − 176.
  assert.equal(portraitRailWidth(500, 416), 180);
});

test("portraitRailWidth: the 160 floor binds when both terms run small", () => {
  // 0.38 × 100 = 38 and the height term is generous — the floor rescues it.
  assert.equal(portraitRailWidth(100, 2000), 160);
  // On a short window the height term dips below the floor too; floor wins.
  assert.equal(portraitRailWidth(500, 300), 160);
});

test("portraitRailWidth: the 300 cap binds on wide panes", () => {
  // 0.38 × 1000 = 380 and the height term is huge — the cap wins.
  assert.equal(portraitRailWidth(1000, 2000), 300);
});

test("reservation: the cap shrinks by exactly the reserved amount", () => {
  // 300 = PORTRAIT_RAIL_MAX_WIDTH, hardcoded here: the expectation must not
  // be derived from the constant it pins.
  assert.equal(threadWidthMax(1920, 300), 1260);
  assert.equal(threadWidthMax(1920, 100), 1460);
  // The reservation moves the CEILING; in-range values still pass through,
  // and values over the new ceiling land on it.
  assert.equal(clampThreadWidth(700, 1920, 300), 700);
  assert.equal(clampThreadWidth(1300, 1920, 300), 1260);
  assert.equal(clampThreadWidth(2000, 1920, 300), 1260);
});

test("reservation: the floor still wins on rows too narrow for everything", () => {
  assert.equal(threadWidthMax(500, 300), THREAD_WIDTH_MIN);
  assert.equal(clampThreadWidth(2000, 500, 300), THREAD_WIDTH_MIN);
});

test("zero reservation is identical to the pre-reservation math", () => {
  assert.equal(threadWidthMax(1920, 0), threadWidthMax(1920));
  assert.equal(threadWidthMax(1920, 0), 1560);
  assert.equal(clampThreadWidth(700, 1920, 0), 700);
  assert.equal(clampThreadWidth(2000, 1920, 0), 1560);
  assert.equal(threadWidthMax(500, 0), THREAD_WIDTH_MIN);
});

test("paneRowStyle sets both vars; the rail var is portraitRailWidth's output", () => {
  // 180/300/160 are pinned independently by the portraitRailWidth bound
  // tests above — the style must EQUAL the width function, never re-derive
  // it with its own math.
  assert.equal(paneRowStyle(500, 416, true)["--thread-width"], "500px");
  assert.equal(paneRowStyle(500, 416, true)["--portrait-rail-w"], "180px");
  assert.equal(paneRowStyle(1000, 2000, true)["--portrait-rail-w"], "300px");
  assert.equal(paneRowStyle(100, 2000, true)["--portrait-rail-w"], "160px");
});

test("paneRowStyle zeroes the rail var while the rail is hidden", () => {
  const style = paneRowStyle(500, 2000, false);
  assert.equal(style["--thread-width"], "500px");
  assert.equal(style["--portrait-rail-w"], "0px");
});

// The rail-wiring source scan from the rail branch is NOT ported: on this
// surface there is no portrait rail, so repos passes railVisible=false and
// the scan's assertions are untrue here. The reservation BEHAVIOR itself is
// covered by useThreadPaneWidth.test.mjs, which mounts the hook and asserts
// the observed clamps — behavior, not text.

// The row-resize re-clamp (ResizeObserver) is pinned BEHAVIORALLY in
// useThreadPaneWidth.test.mjs — it mounts the hook under jsdom with a stub
// observer and asserts what the hook actually observed. It replaces an
// earlier source scan here, which pinned the code's TEXT and missed the
// late-mount defect entirely (QA 2026-09-14).
