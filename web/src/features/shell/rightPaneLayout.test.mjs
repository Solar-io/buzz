import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActiveTab, rightPaneLayout } from "./rightPaneLayout.ts";

/**
 * The right pane's tab model. Phase 1 (phase-1.md §3) made it a strip with
 * Work first; Phase 2 (phase-2.md) moved threads INLINE under their message,
 * so the strip is now Work and — in an agent DM — Thinking. The table below
 * is that contract, transcribed by hand from the design docs, not computed
 * from rightPaneLayout:
 *
 *   tabs     work, + activity in an agent DM whose thinking pane is open
 *   active   the chosen tab if it exists, else previous, else work
 *   activity agentDm && active = activity
 *
 * Columns: agentDm, active, paneHidden, then the expected tabs, active,
 * activity. `previous` is "work" throughout.
 */
const W = "work";
const WA = "work,activity";
const CONVERSATION_TABLE = [
  // a plain channel: Work alone, whatever was last chosen
  [0, "work", 0, /* → */ W, "work", 0],
  [0, "work", 1, /* → */ W, "work", 0],
  [0, "activity", 0, /* → */ W, "work", 0],
  [0, "activity", 1, /* → */ W, "work", 0],
  // an agent DM
  [1, "work", 0, /* → */ WA, "work", 0],
  [1, "work", 1, /* → */ W, "work", 0],
  [1, "activity", 0, /* → */ WA, "activity", 1],
  [1, "activity", 1, /* → */ W, "work", 0],
];

function input(overrides) {
  return {
    surface: "conversation",
    agentDm: false,
    active: "work",
    previous: "work",
    paneHidden: false,
    webLayerActive: false,
    workTab: true,
    workCollapsed: false,
    ...overrides,
  };
}

test("conversation: every combination matches the tab model", () => {
  assert.equal(CONVERSATION_TABLE.length, 8, "2 × 2 × 2 inputs");
  const seen = new Set();
  for (const row of CONVERSATION_TABLE) {
    const [agentDm, active, paneHidden] = row;
    seen.add(row.slice(0, 3).join(","));
    const got = rightPaneLayout(
      input({
        agentDm: agentDm === 1,
        active,
        paneHidden: paneHidden === 1,
      }),
    );
    const [tabs, resolved, activity] = row.slice(3);
    assert.deepEqual(
      [got.tabs.join(","), got.active, got.activity],
      [tabs, resolved, activity === 1],
      `inputs ${row.slice(0, 3).join(",")}`,
    );
    assert.equal(got.hostVisible, true);
  }
  assert.equal(seen.size, 8, "no duplicated input rows");
});

test("the strip is Work, then Thinking — a thread is never a tab", () => {
  // Every surface and every pane state: the only ids the strip can hold.
  for (const surface of ["conversation", "view", "none"]) {
    for (const agentDm of [false, true]) {
      for (const paneHidden of [false, true]) {
        const { tabs } = rightPaneLayout(
          input({ surface, agentDm, paneHidden, active: "activity" }),
        );
        assert.equal(tabs[0], "work", "Work is always the first tab");
        assert.ok(
          tabs.every((tab) => tab === "work" || tab === "activity"),
          `unexpected tab in ${tabs.join(",")}`,
        );
        assert.ok(tabs.length <= 2);
      }
    }
  }
  // The full layout object: no thread fields left to mount a pane from.
  assert.deepEqual(rightPaneLayout(input({ agentDm: true, active: "activity" })), {
    hostVisible: true,
    tabs: ["work", "activity"],
    active: "activity",
    handle: true,
    work: null,
    activity: true,
  });
});

test("handle renders for a hidden agent-DM pane", () => {
  const layout = rightPaneLayout(input({ agentDm: true, paneHidden: true }));
  assert.equal(layout.activity, false, "the thinking tab is gone");
  assert.deepEqual(layout.tabs, ["work"]);
  assert.equal(layout.work, "open");
  assert.equal(layout.handle, true, "the Work rail is what the handle sizes");
});

test("view and empty surfaces show Work alone", () => {
  const view = rightPaneLayout(
    input({ surface: "view", agentDm: true, active: "activity" }),
  );
  assert.deepEqual(view, {
    hostVisible: true,
    tabs: ["work"],
    active: "work",
    handle: true,
    work: "open",
    activity: false,
  });
  const none = rightPaneLayout(
    input({ surface: "none", agentDm: true, active: "activity" }),
  );
  assert.deepEqual(none.tabs, ["work"]);
  assert.equal(none.activity, false, "no conversation: no thinking pane");
});

test("web layer hides the host but keeps it mounted", () => {
  const covered = rightPaneLayout(
    input({ agentDm: true, active: "activity", webLayerActive: true }),
  );
  assert.equal(covered.hostVisible, false);
  // The pane is still laid out (mounted, display:none) behind Files.
  assert.equal(covered.activity, true);
  assert.equal(
    rightPaneLayout(input({ agentDm: true })).hostVisible,
    true,
    "uncovered, the host shows",
  );
  assert.equal(
    rightPaneLayout(input({ surface: "view", webLayerActive: true }))
      .hostVisible,
    false,
  );
});

test("closing Thinking returns to the previous tab, else to Work", () => {
  // In an agent DM, on Thinking.
  const open = rightPaneLayout(
    input({ agentDm: true, active: "activity", previous: "work" }),
  );
  assert.deepEqual(open.tabs, ["work", "activity"]);
  assert.equal(open.active, "activity");
  // Its ✕ hides the pane: the tab disappears and the pane lands on Work.
  const closed = rightPaneLayout(
    input({
      agentDm: true,
      paneHidden: true,
      active: "activity",
      previous: "work",
    }),
  );
  assert.deepEqual(closed.tabs, ["work"]);
  assert.equal(closed.active, "work");
  assert.equal(closed.activity, false);
  // With no tabs at all there is nothing to land on.
  assert.equal(resolveActiveTab("activity", "work", []), null);
  assert.equal(resolveActiveTab("activity", "work", ["work"]), "work");
});

test("?view=work and a folded rail", () => {
  const workPage = rightPaneLayout(input({ surface: "view", workTab: false }));
  assert.deepEqual(workPage.tabs, [], "the Work page needs no Work rail");
  assert.equal(workPage.work, null);
  assert.equal(workPage.handle, false);

  const folded = rightPaneLayout(input({ workCollapsed: true }));
  assert.equal(folded.work, "collapsed");
  assert.equal(folded.handle, false, "a 44 px strip is not resizable");
});
