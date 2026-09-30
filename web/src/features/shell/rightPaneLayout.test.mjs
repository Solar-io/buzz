import assert from "node:assert/strict";
import { test } from "node:test";
import { rightPaneLayout } from "./rightPaneLayout.ts";

/**
 * The right pane's show/hide rules, moved out of routes/repos.tsx in the web
 * redesign's Phase 0. Every expected row below was transcribed from the
 * pre-extraction JSX at df7363b9a (repos.tsx:944-1009), NOT computed from
 * rightPaneLayout — so a changed rule fails here instead of redefining its
 * own expectation:
 *
 *   handle        (threadOpen || dmAgentPubkey)
 *   threadDocked  threadRoot && (!dmAgentPubkey || rightTab === "thread")
 *   detached      (!dmAgentPubkey || rightTab === "thread") && detachedThread
 *   mobileOnly    threadRoot && dmAgentPubkey && rightTab === "thinking"
 *   activity      dmAgentPubkey && !dmPaneHidden &&
 *                   (!threadOpen || rightTab === "thinking")
 *
 * Columns: threadRoot, detached, agentDm, rightTab, paneHidden, then the
 * expected handle, threadDocked, detached, threadMobileOnly, activity.
 */
const CONVERSATION_TABLE = [
  [0, 0, 0, "thinking", 0, /* → */ 0, 0, 0, 0, 0],
  [0, 0, 0, "thinking", 1, /* → */ 0, 0, 0, 0, 0],
  [0, 0, 0, "thread", 0, /* → */ 0, 0, 0, 0, 0],
  [0, 0, 0, "thread", 1, /* → */ 0, 0, 0, 0, 0],
  [0, 0, 1, "thinking", 0, /* → */ 1, 0, 0, 0, 1],
  [0, 0, 1, "thinking", 1, /* → */ 1, 0, 0, 0, 0],
  [0, 0, 1, "thread", 0, /* → */ 1, 0, 0, 0, 1],
  [0, 0, 1, "thread", 1, /* → */ 1, 0, 0, 0, 0],
  [0, 1, 0, "thinking", 0, /* → */ 1, 0, 1, 0, 0],
  [0, 1, 0, "thinking", 1, /* → */ 1, 0, 1, 0, 0],
  [0, 1, 0, "thread", 0, /* → */ 1, 0, 1, 0, 0],
  [0, 1, 0, "thread", 1, /* → */ 1, 0, 1, 0, 0],
  [0, 1, 1, "thinking", 0, /* → */ 1, 0, 0, 0, 1],
  [0, 1, 1, "thinking", 1, /* → */ 1, 0, 0, 0, 0],
  [0, 1, 1, "thread", 0, /* → */ 1, 0, 1, 0, 0],
  [0, 1, 1, "thread", 1, /* → */ 1, 0, 1, 0, 0],
  [1, 0, 0, "thinking", 0, /* → */ 1, 1, 0, 0, 0],
  [1, 0, 0, "thinking", 1, /* → */ 1, 1, 0, 0, 0],
  [1, 0, 0, "thread", 0, /* → */ 1, 1, 0, 0, 0],
  [1, 0, 0, "thread", 1, /* → */ 1, 1, 0, 0, 0],
  [1, 0, 1, "thinking", 0, /* → */ 1, 0, 0, 1, 1],
  [1, 0, 1, "thinking", 1, /* → */ 1, 0, 0, 1, 0],
  [1, 0, 1, "thread", 0, /* → */ 1, 1, 0, 0, 0],
  [1, 0, 1, "thread", 1, /* → */ 1, 1, 0, 0, 0],
  [1, 1, 0, "thinking", 0, /* → */ 1, 1, 1, 0, 0],
  [1, 1, 0, "thinking", 1, /* → */ 1, 1, 1, 0, 0],
  [1, 1, 0, "thread", 0, /* → */ 1, 1, 1, 0, 0],
  [1, 1, 0, "thread", 1, /* → */ 1, 1, 1, 0, 0],
  [1, 1, 1, "thinking", 0, /* → */ 1, 0, 0, 1, 1],
  [1, 1, 1, "thinking", 1, /* → */ 1, 0, 0, 1, 0],
  [1, 1, 1, "thread", 0, /* → */ 1, 1, 1, 0, 0],
  [1, 1, 1, "thread", 1, /* → */ 1, 1, 1, 0, 0],
];

function input(overrides) {
  return {
    surface: "conversation",
    threadRoot: false,
    detached: false,
    agentDm: false,
    rightTab: "thinking",
    paneHidden: false,
    webLayerActive: false,
    ...overrides,
  };
}

test("conversation: every combination matches the pre-extraction rules", () => {
  assert.equal(CONVERSATION_TABLE.length, 32, "all 2^5 input combinations");
  const seen = new Set();
  for (const row of CONVERSATION_TABLE) {
    const [threadRoot, detached, agentDm, rightTab, paneHidden] = row;
    seen.add(row.slice(0, 5).join(","));
    const got = rightPaneLayout(
      input({
        threadRoot: threadRoot === 1,
        detached: detached === 1,
        agentDm: agentDm === 1,
        rightTab,
        paneHidden: paneHidden === 1,
      }),
    );
    const expected = row.slice(5).map((bit) => bit === 1);
    assert.deepEqual(
      [
        got.handle,
        got.threadDocked,
        got.detached,
        got.threadMobileOnly,
        got.activity,
      ],
      expected,
      `inputs ${row.slice(0, 5).join(",")}`,
    );
    assert.equal(got.hostVisible, true);
  }
  assert.equal(seen.size, 32, "no duplicated input rows");
});

test("handle renders for a hidden agent-DM pane with no thread", () => {
  const layout = rightPaneLayout(input({ agentDm: true, paneHidden: true }));
  assert.equal(layout.activity, false, "nothing is docked");
  assert.equal(layout.threadDocked, false);
  assert.equal(layout.detached, false);
  assert.equal(layout.handle, true, "the kept quirk: the handle still shows");
});

test("view surface: detached thread docks with no handle", () => {
  const layout = rightPaneLayout(
    input({
      surface: "view",
      detached: true,
      agentDm: true,
      threadRoot: true,
      rightTab: "thinking",
    }),
  );
  assert.deepEqual(layout, {
    hostVisible: true,
    handle: false,
    threadDocked: false,
    detached: true,
    threadMobileOnly: false,
    activity: false,
  });
  const empty = rightPaneLayout(input({ surface: "view" }));
  assert.equal(empty.handle, false);
  assert.equal(empty.detached, false);
  const none = rightPaneLayout(
    input({ surface: "none", detached: true, agentDm: true }),
  );
  assert.equal(none.detached, false, "no conversation, no view: nothing");
  assert.equal(none.handle, false);
});

test("web layer hides the host but keeps it mounted", () => {
  const covered = rightPaneLayout(
    input({ threadRoot: true, webLayerActive: true }),
  );
  assert.equal(covered.hostVisible, false);
  // The panes are still laid out (mounted, display:none) — a thread draft
  // survives the Files overlay.
  assert.equal(covered.threadDocked, true);
  assert.equal(covered.handle, true);
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
