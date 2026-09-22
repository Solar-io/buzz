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
  rightTab: "thinking",
  lastThreadRootId: null,
});

const freshChannel = () => ({
  ...freshDm(),
  agentDm: false,
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
      rightTab: "thread",
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
      rightTab: "thread",
    }),
    false,
  );
});

// ── 🧠 toggle ──────────────────────────────────────────────────────────────

test("showing selects the thinking tab, un-collapses, and raises the sheet", () => {
  assert.deepEqual(toggleThinkingPatch({ ...freshDm(), paneHidden: true }), {
    rightTab: "thinking",
    paneHidden: false,
    mobileOpen: true,
  });
  assert.deepEqual(
    toggleThinkingPatch({
      ...freshDm(),
      threadRootId: "t1",
      rightTab: "thread",
    }),
    { rightTab: "thinking", paneHidden: false, mobileOpen: true },
  );
});

test("hiding collapses the pane on both form factors at once", () => {
  assert.deepEqual(toggleThinkingPatch(freshDm()), {
    paneHidden: true,
    mobileOpen: false,
  });
  assert.deepEqual(toggleThinkingPatch({ ...freshDm(), mobileOpen: true }), {
    paneHidden: true,
    mobileOpen: false,
  });
});

// ── Replies visibility + gating ────────────────────────────────────────────

test("a thread shows in a plain channel whenever a root is open", () => {
  assert.equal(threadPaneVisible(freshChannel()), false);
  assert.equal(
    threadPaneVisible({ ...freshChannel(), threadRootId: "t1" }),
    true,
  );
});

test("in an agent DM the tab decides which pane the thread occupies", () => {
  const dm = { ...freshDm(), threadRootId: "t1" };
  assert.equal(threadPaneVisible(dm), false);
  assert.equal(threadPaneVisible({ ...dm, rightTab: "thread" }), true);
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
    rightTab: "thread",
  });
  assert.deepEqual(patch, { rightTab: "thinking" });
});

test("hiding in a plain channel closes the pane like its own close button", () => {
  const patch = toggleThreadPatch({ ...freshChannel(), threadRootId: "t1" });
  assert.deepEqual(patch, { threadRootId: null });
});

test("showing restores the last root in a plain channel and un-collapses in a DM", () => {
  assert.deepEqual(
    toggleThreadPatch({ ...freshChannel(), lastThreadRootId: "t1" }),
    { threadRootId: "t1", rightTab: "thread", paneHidden: false },
  );
  assert.deepEqual(
    toggleThreadPatch({
      ...freshDm(),
      paneHidden: true,
      threadRootId: "t1",
    }),
    { threadRootId: "t1", rightTab: "thread", paneHidden: false },
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
      { ...base, paneHidden: true },
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
            rightTab: backThinking.rightTab,
          },
          {
            paneHidden: variant.paneHidden,
            threadRootId: variant.threadRootId,
            rightTab: variant.rightTab,
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
            // rightTab only decides anything in an agent DM — a plain
            // channel has no tabs, and the toggle legitimately leaves the
            // field wherever the DM machinery last put it.
            ...(variant.agentDm ? { rightTab: backThreads.rightTab } : {}),
            paneHidden: backThreads.paneHidden,
          },
          {
            threadRootId: variant.threadRootId,
            ...(variant.agentDm ? { rightTab: variant.rightTab } : {}),
            paneHidden: variant.paneHidden,
          },
        );
      }
    }
  }
});
