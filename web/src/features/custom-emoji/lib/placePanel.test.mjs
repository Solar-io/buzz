import assert from "node:assert/strict";
import test from "node:test";

import { GAP, PANEL_H, PANEL_W, placePanel } from "./placePanel.ts";

const VIEWPORT = { width: 1280, height: 800 };
const rect = (top, left) => ({ top, bottom: top + 32, left });

test("with room above, the panel opens above the anchor", () => {
  const { top, left } = placePanel(rect(700, 400), VIEWPORT);
  assert.equal(top, 700 - PANEL_H - GAP);
  assert.equal(left, 400);
});

test("with no room above, it opens below", () => {
  const anchor = rect(40, 400);
  const { top } = placePanel(anchor, VIEWPORT);
  assert.equal(top, anchor.bottom + GAP);
});

test("a right-edge anchor is pulled back inside the viewport", () => {
  const { left } = placePanel(rect(700, 1260), VIEWPORT);
  assert.equal(left, VIEWPORT.width - PANEL_W - GAP);
  assert.ok(left + PANEL_W <= VIEWPORT.width, "the panel fits");
});

test("a narrow viewport still leaves the panel on-screen at the left gap", () => {
  const { left } = placePanel(rect(700, 4), { width: 320, height: 800 });
  assert.equal(left, GAP, "never negative, however narrow the window");
});

test("a viewport shorter than the panel clamps top to the gap, not below zero", () => {
  // The min alone goes negative here and the search field lands off-screen.
  const { top } = placePanel(rect(10, 100), { width: 1280, height: 300 });
  assert.equal(top, GAP);
});

test("no anchor rect yields the origin rather than NaN", () => {
  assert.deepEqual(placePanel(null, VIEWPORT), { left: 0, top: 0 });
});
