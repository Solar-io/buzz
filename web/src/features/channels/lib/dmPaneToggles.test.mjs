import assert from "node:assert/strict";
import { test } from "node:test";

import * as toggles from "./dmPaneToggles.ts";

const { thinkingPaneVisible, toggleThinkingPatch } = toggles;

/**
 * The two-way 🧠 toggle (Sam, 2026-09-22). Fixtures are spelled out field by
 * field — a shared "base state" helper would move with the very bug under
 * test the day someone edits its defaults.
 *
 * The Replies toggle this file also covered is gone with the thread tab (web
 * redesign Phase 2: threads open inline, under their message); its seven
 * tests went with it, and the first test below pins that the policy has no
 * thread half left to half-wire.
 */

const freshDm = () => ({
  agentDm: true,
  paneHidden: false,
  mobileOpen: false,
  mobile: false,
  // Entering an agent DM makes the thinking tab active (phase-1 §3).
  active: "activity",
  previous: "work",
});

const freshChannel = () => ({
  ...freshDm(),
  agentDm: false,
  active: "work",
});

test("the policy exposes the thinking toggle only — no thread pane to toggle", () => {
  assert.deepEqual(Object.keys(toggles).sort(), [
    "thinkingPaneVisible",
    "toggleThinkingPatch",
  ]);
});

// ── 🧠 visibility ──────────────────────────────────────────────────────────

test("an agent DM with nothing hidden shows the thinking pane", () => {
  assert.equal(thinkingPaneVisible(freshDm()), true);
});

test("a collapsed pane, the Work tab, and non-DM channels all hide it", () => {
  assert.equal(thinkingPaneVisible({ ...freshDm(), paneHidden: true }), false);
  assert.equal(thinkingPaneVisible({ ...freshDm(), active: "work" }), false);
  assert.equal(thinkingPaneVisible(freshChannel()), false);
});

test("below lg the pane is on screen only while the sheet is open", () => {
  const mobile = { ...freshDm(), mobile: true };
  assert.equal(thinkingPaneVisible(mobile), false);
  assert.equal(thinkingPaneVisible({ ...mobile, mobileOpen: true }), true);
  // The sheet does not override the tab: on Work, the pane is not showing.
  assert.equal(
    thinkingPaneVisible({ ...mobile, mobileOpen: true, active: "work" }),
    false,
  );
});

// ── 🧠 toggle ──────────────────────────────────────────────────────────────

test("showing selects the thinking tab, un-collapses, and raises the sheet", () => {
  assert.deepEqual(
    toggleThinkingPatch({ ...freshDm(), paneHidden: true, active: "work" }),
    {
      active: "activity",
      previous: "work",
      paneHidden: false,
      mobileOpen: true,
    },
  );
});

test("hiding collapses the pane on both form factors at once", () => {
  assert.deepEqual(toggleThinkingPatch(freshDm()), {
    paneHidden: true,
    mobileOpen: false,
    active: "work",
  });
  assert.deepEqual(toggleThinkingPatch({ ...freshDm(), mobileOpen: true }), {
    paneHidden: true,
    mobileOpen: false,
    active: "work",
  });
});

// ── round-trips: two clicks come back ──────────────────────────────────────

function apply(state, patch) {
  return { ...state, ...patch };
}

test("the toggle is its own inverse", () => {
  for (const variant of [
    freshDm(),
    // A hidden thinking tab is not on screen: the pane shows Work.
    { ...freshDm(), paneHidden: true, active: "work" },
  ]) {
    const after = apply(variant, toggleThinkingPatch(variant));
    const back = apply(after, toggleThinkingPatch(after));
    // The sheet flag is the one field the desktop never reads, so compare
    // the fields that decide rendering.
    assert.deepEqual(
      { paneHidden: back.paneHidden, active: back.active },
      { paneHidden: variant.paneHidden, active: variant.active },
    );
  }
});
