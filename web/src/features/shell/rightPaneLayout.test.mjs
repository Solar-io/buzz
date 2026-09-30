import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActiveTab, rightPaneLayout } from "./rightPaneLayout.ts";

/**
 * The right pane's tab model (phase-1.md §3). Phase 0 pinned the old
 * show/hide rules against the pre-extraction JSX; Phase 1 replaces those
 * rules on purpose, so the table below is the NEW contract, transcribed by
 * hand from the design doc — not computed from rightPaneLayout:
 *
 *   tabs     work, + thread while a thread is open, + activity in an agent
 *            DM whose thinking pane is not hidden
 *   active   the chosen tab if it exists, else previous, else work
 *   docked   threadRoot && active = thread
 *   detached detached && active = thread
 *   activity agentDm && active = activity
 *
 * Columns: threadRoot, detached, agentDm, active, paneHidden, then the
 * expected tabs, active, threadDocked, detached, activity. `previous` is
 * "work" throughout.
 */
const W = "work";
const WT = "work,thread";
const WA = "work,activity";
const WTA = "work,thread,activity";
const CONVERSATION_TABLE = [
  // no thread, plain channel
  [0, 0, 0, "work", 0, /* → */ W, "work", 0, 0, 0],
  [0, 0, 0, "work", 1, /* → */ W, "work", 0, 0, 0],
  [0, 0, 0, "thread", 0, /* → */ W, "work", 0, 0, 0],
  [0, 0, 0, "thread", 1, /* → */ W, "work", 0, 0, 0],
  [0, 0, 0, "activity", 0, /* → */ W, "work", 0, 0, 0],
  [0, 0, 0, "activity", 1, /* → */ W, "work", 0, 0, 0],
  // no thread, agent DM
  [0, 0, 1, "work", 0, /* → */ WA, "work", 0, 0, 0],
  [0, 0, 1, "work", 1, /* → */ W, "work", 0, 0, 0],
  [0, 0, 1, "thread", 0, /* → */ WA, "work", 0, 0, 0],
  [0, 0, 1, "thread", 1, /* → */ W, "work", 0, 0, 0],
  [0, 0, 1, "activity", 0, /* → */ WA, "activity", 0, 0, 1],
  [0, 0, 1, "activity", 1, /* → */ W, "work", 0, 0, 0],
  // a kept-open thread from another channel
  [0, 1, 0, "work", 0, /* → */ WT, "work", 0, 0, 0],
  [0, 1, 0, "work", 1, /* → */ WT, "work", 0, 0, 0],
  [0, 1, 0, "thread", 0, /* → */ WT, "thread", 0, 1, 0],
  [0, 1, 0, "thread", 1, /* → */ WT, "thread", 0, 1, 0],
  [0, 1, 0, "activity", 0, /* → */ WT, "work", 0, 0, 0],
  [0, 1, 0, "activity", 1, /* → */ WT, "work", 0, 0, 0],
  [0, 1, 1, "work", 0, /* → */ WTA, "work", 0, 0, 0],
  [0, 1, 1, "work", 1, /* → */ WT, "work", 0, 0, 0],
  [0, 1, 1, "thread", 0, /* → */ WTA, "thread", 0, 1, 0],
  [0, 1, 1, "thread", 1, /* → */ WT, "thread", 0, 1, 0],
  [0, 1, 1, "activity", 0, /* → */ WTA, "activity", 0, 0, 1],
  [0, 1, 1, "activity", 1, /* → */ WT, "work", 0, 0, 0],
  // the open channel's thread
  [1, 0, 0, "work", 0, /* → */ WT, "work", 0, 0, 0],
  [1, 0, 0, "work", 1, /* → */ WT, "work", 0, 0, 0],
  [1, 0, 0, "thread", 0, /* → */ WT, "thread", 1, 0, 0],
  [1, 0, 0, "thread", 1, /* → */ WT, "thread", 1, 0, 0],
  [1, 0, 0, "activity", 0, /* → */ WT, "work", 0, 0, 0],
  [1, 0, 0, "activity", 1, /* → */ WT, "work", 0, 0, 0],
  [1, 0, 1, "work", 0, /* → */ WTA, "work", 0, 0, 0],
  [1, 0, 1, "work", 1, /* → */ WT, "work", 0, 0, 0],
  [1, 0, 1, "thread", 0, /* → */ WTA, "thread", 1, 0, 0],
  [1, 0, 1, "thread", 1, /* → */ WT, "thread", 1, 0, 0],
  [1, 0, 1, "activity", 0, /* → */ WTA, "activity", 0, 0, 1],
  [1, 0, 1, "activity", 1, /* → */ WT, "work", 0, 0, 0],
  // both
  [1, 1, 0, "work", 0, /* → */ WT, "work", 0, 0, 0],
  [1, 1, 0, "work", 1, /* → */ WT, "work", 0, 0, 0],
  [1, 1, 0, "thread", 0, /* → */ WT, "thread", 1, 1, 0],
  [1, 1, 0, "thread", 1, /* → */ WT, "thread", 1, 1, 0],
  [1, 1, 0, "activity", 0, /* → */ WT, "work", 0, 0, 0],
  [1, 1, 0, "activity", 1, /* → */ WT, "work", 0, 0, 0],
  [1, 1, 1, "work", 0, /* → */ WTA, "work", 0, 0, 0],
  [1, 1, 1, "work", 1, /* → */ WT, "work", 0, 0, 0],
  [1, 1, 1, "thread", 0, /* → */ WTA, "thread", 1, 1, 0],
  [1, 1, 1, "thread", 1, /* → */ WT, "thread", 1, 1, 0],
  [1, 1, 1, "activity", 0, /* → */ WTA, "activity", 0, 0, 1],
  [1, 1, 1, "activity", 1, /* → */ WT, "work", 0, 0, 0],
];

function input(overrides) {
  return {
    surface: "conversation",
    threadRoot: false,
    detached: false,
    agentDm: false,
    active: "work",
    previous: "work",
    paneHidden: false,
    webLayerActive: false,
    workTab: true,
    threadIsTab: true,
    workCollapsed: false,
    ...overrides,
  };
}

test("conversation: every combination matches the tab model", () => {
  assert.equal(CONVERSATION_TABLE.length, 48, "2 × 2 × 2 × 3 × 2 inputs");
  const seen = new Set();
  for (const row of CONVERSATION_TABLE) {
    const [threadRoot, detached, agentDm, active, paneHidden] = row;
    seen.add(row.slice(0, 5).join(","));
    const got = rightPaneLayout(
      input({
        threadRoot: threadRoot === 1,
        detached: detached === 1,
        agentDm: agentDm === 1,
        active,
        paneHidden: paneHidden === 1,
      }),
    );
    const [tabs, resolved, docked, kept, activity] = row.slice(5);
    assert.deepEqual(
      [
        got.tabs.join(","),
        got.active,
        got.threadDocked,
        got.detached,
        got.activity,
      ],
      [tabs, resolved, docked === 1, kept === 1, activity === 1],
      `inputs ${row.slice(0, 5).join(",")}`,
    );
    assert.equal(got.hostVisible, true);
    // The open channel's thread is always MOUNTED (its sheet below lg).
    assert.equal(got.thread, threadRoot === 1);
  }
  assert.equal(seen.size, 48, "no duplicated input rows");
});

test("handle renders for a hidden agent-DM pane with no thread", () => {
  const layout = rightPaneLayout(input({ agentDm: true, paneHidden: true }));
  assert.equal(layout.activity, false, "the thinking tab is gone");
  assert.equal(layout.threadDocked, false);
  assert.equal(layout.detached, false);
  assert.deepEqual(layout.tabs, ["work"]);
  assert.equal(layout.work, "open");
  assert.equal(layout.handle, true, "the Work rail is what the handle sizes");
});

test("view surface: a detached thread is a tab beside Work", () => {
  const layout = rightPaneLayout(
    input({
      surface: "view",
      detached: true,
      agentDm: true,
      threadRoot: true,
      active: "thread",
    }),
  );
  assert.deepEqual(layout, {
    hostVisible: true,
    tabs: ["work", "thread"],
    active: "thread",
    handle: true,
    work: null,
    thread: false,
    threadDocked: false,
    threadFocus: false,
    detached: true,
    activity: false,
  });
  const empty = rightPaneLayout(input({ surface: "view" }));
  assert.deepEqual(empty.tabs, ["work"]);
  assert.equal(empty.detached, false);
  const none = rightPaneLayout(
    input({ surface: "none", detached: true, agentDm: true, active: "thread" }),
  );
  assert.equal(none.detached, false, "no conversation, no view: no thread");
  assert.deepEqual(none.tabs, ["work"]);
});

test("web layer hides the host but keeps it mounted", () => {
  const covered = rightPaneLayout(
    input({ threadRoot: true, active: "thread", webLayerActive: true }),
  );
  assert.equal(covered.hostVisible, false);
  // The panes are still laid out (mounted, display:none) — a thread draft
  // survives the Files overlay.
  assert.equal(covered.threadDocked, true);
  assert.equal(covered.thread, true);
  assert.equal(
    rightPaneLayout(input({ threadRoot: true })).hostVisible,
    true,
    "uncovered, the host shows",
  );
  assert.equal(
    rightPaneLayout(input({ surface: "view", webLayerActive: true }))
      .hostVisible,
    false,
  );
});

test("Work is always the first tab; closing a thread returns to the previous tab", () => {
  // In an agent DM the viewer opened a thread from the thinking tab.
  const open = rightPaneLayout(
    input({
      agentDm: true,
      threadRoot: true,
      active: "thread",
      previous: "activity",
    }),
  );
  assert.deepEqual(open.tabs, ["work", "thread", "activity"]);
  assert.equal(open.tabs[0], "work");
  assert.equal(open.active, "thread");
  // Closing it: the thread tab disappears and the pane returns to thinking,
  // not to Work and not to nothing.
  const closed = rightPaneLayout(
    input({
      agentDm: true,
      threadRoot: false,
      active: "thread",
      previous: "activity",
    }),
  );
  assert.deepEqual(closed.tabs, ["work", "activity"]);
  assert.equal(closed.active, "activity");
  assert.equal(closed.activity, true);
  // With the previous tab gone too, it lands on Work.
  assert.equal(resolveActiveTab("thread", "activity", ["work"]), "work");
});

test("focus layout keeps the thread an overlay; ?view=work and a folded rail", () => {
  const focus = rightPaneLayout(
    input({ threadRoot: true, detached: true, threadIsTab: false }),
  );
  assert.deepEqual(focus.tabs, ["work"], "a focus thread is not a tab");
  assert.equal(focus.thread, true, "…but it is mounted (its own overlay)");
  assert.equal(focus.threadFocus, true, "…and stays on screen at lg");
  assert.equal(focus.detached, true);
  assert.equal(focus.threadDocked, false);

  const workPage = rightPaneLayout(input({ surface: "view", workTab: false }));
  assert.deepEqual(workPage.tabs, [], "the Work page needs no Work rail");
  assert.equal(workPage.work, null);
  assert.equal(workPage.handle, false);

  const folded = rightPaneLayout(input({ workCollapsed: true }));
  assert.equal(folded.work, "collapsed");
  assert.equal(folded.handle, false, "a 44 px strip is not resizable");
});
