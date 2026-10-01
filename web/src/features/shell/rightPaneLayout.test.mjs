import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveActiveTab,
  rightPaneLayout,
  rightPaneStrip,
} from "./rightPaneLayout.ts";

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
    webLayer: "none",
    filesWorkOpen: false,
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
  assert.deepEqual(
    rightPaneLayout(input({ agentDm: true, active: "activity" })),
    {
      hostVisible: true,
      tabs: ["work", "activity"],
      active: "activity",
      handle: true,
      work: null,
      activity: true,
      conversationCovered: false,
    },
  );
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
    conversationCovered: false,
  });
  const none = rightPaneLayout(
    input({ surface: "none", agentDm: true, active: "activity" }),
  );
  assert.deepEqual(none.tabs, ["work"]);
  assert.equal(none.activity, false, "no conversation: no thinking pane");
});

test("a link page hides the host but keeps it mounted", () => {
  const covered = rightPaneLayout(
    input({ agentDm: true, active: "activity", webLayer: "page" }),
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
    rightPaneLayout(input({ surface: "view", webLayer: "page" })).hostVisible,
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
  assert.equal(folded.handle, false, "a 48 px strip is not resizable");
});

// Phase 4 (Files artboard): Files is a page in the main column, and the dock
// beside it is the folded Work strip — whatever the conversation behind it
// had docked, and whatever the viewer's conversation fold preference is.
test("Files keeps the Work strip beside it; Thinking is not a tab", () => {
  for (const agentDm of [false, true]) {
    for (const workCollapsed of [false, true]) {
      const got = rightPaneLayout(
        input({
          agentDm,
          active: "activity",
          workCollapsed,
          webLayer: "files",
        }),
      );
      assert.deepEqual(
        got,
        {
          hostVisible: true,
          tabs: ["work"],
          active: "work",
          handle: false,
          work: "collapsed",
          activity: false,
          conversationCovered: true,
        },
        `agentDm=${agentDm} workCollapsed=${workCollapsed}`,
      );
    }
  }
});

test("unfolding Work beside Files opens the rail without touching the fold preference", () => {
  const open = rightPaneLayout(
    input({ webLayer: "files", filesWorkOpen: true, workCollapsed: true }),
  );
  assert.equal(open.work, "open");
  assert.equal(open.handle, true, "an open rail is resizable");
  // Back on the conversation, the viewer's own fold still rules.
  const back = rightPaneLayout(
    input({ webLayer: "none", filesWorkOpen: true, workCollapsed: true }),
  );
  assert.equal(back.work, "collapsed");
  assert.equal(back.conversationCovered, false);
});

test("the Work page is not also a strip beside Files", () => {
  const got = rightPaneLayout(
    input({ surface: "view", workTab: false, webLayer: "files" }),
  );
  assert.deepEqual(got.tabs, []);
  assert.equal(got.work, null);
  assert.equal(got.active, null);
});

// ---- Phase 6: open files join the strip ------------------------------------

test("files: a file tab follows the shell tabs and is what the pane shows", () => {
  const layout = rightPaneLayout(input({ agentDm: true, active: "activity" }));
  const strip = rightPaneStrip(layout, ["f1", "f2"], "f2");
  assert.deepEqual(strip.files, ["f1", "f2"]);
  assert.equal(strip.activeFile, "f2");
  assert.equal(strip.visible, true);
  // Back on a shell tab: the strip stays, no file is on screen.
  const back = rightPaneStrip(layout, ["f1"], null);
  assert.equal(back.activeFile, null);
  assert.equal(back.visible, true);
  // A key that is no longer open is not on screen.
  assert.equal(rightPaneStrip(layout, ["f1"], "gone").activeFile, null);
});

test("files: one Work tab and no files draws no strip (the rail's own title)", () => {
  const plain = rightPaneLayout(input({}));
  assert.equal(rightPaneStrip(plain, [], null).visible, false);
  assert.equal(rightPaneStrip(plain, [], null).activeFile, null);
  assert.equal(rightPaneStrip(plain, ["f1"], null).visible, true);
});

test("files: a folded Work rail hides the strip unless a file is on screen", () => {
  const folded = rightPaneLayout(input({ workCollapsed: true }));
  assert.equal(folded.work, "collapsed");
  assert.equal(rightPaneStrip(folded, ["f1"], null).visible, false);
  assert.equal(rightPaneStrip(folded, ["f1"], "f1").visible, true);
});

test("files: with no shell tab (?view=work) the last file is on screen", () => {
  const page = rightPaneLayout(input({ surface: "view", workTab: false }));
  assert.deepEqual(page.tabs, []);
  const strip = rightPaneStrip(page, ["f1", "f2"], null);
  assert.equal(strip.activeFile, "f2");
  assert.equal(strip.visible, true);
});

test("files: a link page hides the host, files and all", () => {
  const covered = rightPaneLayout(input({ webLayer: "page" }));
  assert.deepEqual(rightPaneStrip(covered, ["f1"], "f1"), {
    files: [],
    activeFile: null,
    visible: false,
  });
});
