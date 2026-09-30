import assert from "node:assert/strict";
import { test } from "node:test";

import {
  thinkingPaneVisible,
  threadPaneVisible,
  threadToggleAvailable,
  toggleThreadPatch,
  toggleThinkingPatch,
} from "./dmPaneToggles.ts";

/**
 * The two-way 🧠 / Replies toggles (Sam, 2026-09-22). Fixtures are spelled
 * out field by field — a shared "base state" helper would move with the very
 * bug under test the day someone edits its defaults.
 */

const freshDm = () => ({
  agentDm: true,
  paneHidden: false,
  mobileOpen: false,
  mobile: false,
  threadRootId: null,
  // Entering an agent DM makes the thinking tab active (phase-1 §3).
  active: "activity",
  previous: "work",
  lastThreadRootId: null,
});

const freshChannel = () => ({
  ...freshDm(),
  agentDm: false,
  active: "work",
});

// ── 🧠 visibility ──────────────────────────────────────────────────────────

test("an agent DM with nothing hidden shows the thinking pane", () => {
  assert.equal(thinkingPaneVisible(freshDm()), true);
});

test("a collapsed pane, the Replies tab, and non-DM channels all hide it", () => {
  assert.equal(thinkingPaneVisible({ ...freshDm(), paneHidden: true }), false);
  assert.equal(
    thinkingPaneVisible({
      ...freshDm(),
      threadRootId: "t1",
      active: "thread",
    }),
    false,
  );
  assert.equal(thinkingPaneVisible(freshChannel()), false);
});

test("below lg the pane is on screen only while the sheet is open", () => {
  const mobile = { ...freshDm(), mobile: true };
  assert.equal(thinkingPaneVisible(mobile), false);
  assert.equal(thinkingPaneVisible({ ...mobile, mobileOpen: true }), true);
  // The sheet does not override the Replies tab: a thread owns the pane.
  assert.equal(
    thinkingPaneVisible({
      ...mobile,
      mobileOpen: true,
      threadRootId: "t1",
      active: "thread",
    }),
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
  // From the thread tab: thinking becomes active and the thread is where
  // hiding it again will return.
  assert.deepEqual(
    toggleThinkingPatch({
      ...freshDm(),
      threadRootId: "t1",
      active: "thread",
      previous: "activity",
    }),
    {
      active: "activity",
      previous: "thread",
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

// ── Replies visibility + gating ────────────────────────────────────────────

test("a thread shows in a plain channel while its tab is active", () => {
  assert.equal(threadPaneVisible(freshChannel()), false);
  assert.equal(
    threadPaneVisible({
      ...freshChannel(),
      threadRootId: "t1",
      active: "thread",
    }),
    true,
  );
  // Open but behind the Work tab: a tab in the strip, not on screen.
  assert.equal(
    threadPaneVisible({ ...freshChannel(), threadRootId: "t1" }),
    false,
  );
});

test("in an agent DM the tab decides which pane the thread occupies", () => {
  const dm = { ...freshDm(), threadRootId: "t1" };
  assert.equal(threadPaneVisible(dm), false);
  assert.equal(threadPaneVisible({ ...dm, active: "thread" }), true);
});

test("with no live or remembered root the toggle has nothing to show", () => {
  assert.equal(threadToggleAvailable(freshChannel()), false);
  assert.equal(toggleThreadPatch(freshChannel()), null);
  // A remembered root from an earlier open is enough to re-show.
  assert.equal(
    threadToggleAvailable({ ...freshChannel(), lastThreadRootId: "t1" }),
    true,
  );
});

// ── Replies toggle ─────────────────────────────────────────────────────────

test("hiding in an agent DM flips the tab back to thinking and keeps the root", () => {
  const patch = toggleThreadPatch({
    ...freshDm(),
    threadRootId: "t1",
    active: "thread",
    previous: "activity",
  });
  assert.deepEqual(patch, { active: "activity" });
});

test("hiding in a plain channel returns to Work and keeps the thread as a tab", () => {
  const patch = toggleThreadPatch({
    ...freshChannel(),
    threadRootId: "t1",
    active: "thread",
  });
  // The root is untouched: the thread stays a tab (its own ✕ closes it).
  assert.deepEqual(patch, { active: "work" });
});

test("showing restores the last root and makes the thread the active tab", () => {
  assert.deepEqual(
    toggleThreadPatch({ ...freshChannel(), lastThreadRootId: "t1" }),
    { threadRootId: "t1", active: "thread", previous: "work" },
  );
  // A hidden thinking tab stays hidden: the thread is its own tab now.
  assert.deepEqual(
    toggleThreadPatch({
      ...freshDm(),
      paneHidden: true,
      threadRootId: "t1",
      active: "work",
    }),
    { threadRootId: "t1", active: "thread", previous: "work" },
  );
});

// ── round-trips: two clicks come back ──────────────────────────────────────

function apply(state, patch) {
  return { ...state, ...patch };
}

test("both toggles are their own inverse over a four-corner round trip", () => {
  for (const base of [freshDm(), freshChannel()]) {
    for (const variant of [
      base,
      { ...base, threadRootId: "t1", lastThreadRootId: "t1" },
      // A hidden thinking tab is not on screen: the pane shows Work.
      { ...base, paneHidden: true, active: "work" },
    ]) {
      // The 🧠 only exists in an agent DM (its gate is agentPubkey), so its
      // round trip is only meaningful there.
      if (variant.agentDm) {
        const afterThinking = apply(variant, toggleThinkingPatch(variant));
        const backThinking = apply(
          afterThinking,
          toggleThinkingPatch(afterThinking),
        );
        // The sheet flag is the one field the desktop never reads, so compare
        // the fields that decide rendering.
        assert.deepEqual(
          {
            paneHidden: backThinking.paneHidden,
            threadRootId: backThinking.threadRootId,
            active: backThinking.active,
          },
          {
            paneHidden: variant.paneHidden,
            threadRootId: variant.threadRootId,
            active: variant.active,
          },
        );
      }

      if (threadToggleAvailable(variant)) {
        const afterThreads = apply(variant, toggleThreadPatch(variant));
        const backThreads = apply(
          afterThreads,
          toggleThreadPatch(afterThreads),
        );
        assert.deepEqual(
          {
            threadRootId: backThreads.threadRootId,
            active: backThreads.active,
            paneHidden: backThreads.paneHidden,
          },
          {
            threadRootId: variant.threadRootId,
            active: variant.active,
            paneHidden: variant.paneHidden,
          },
        );
      }
    }
  }
});
