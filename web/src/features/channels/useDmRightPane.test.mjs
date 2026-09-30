import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

// The DM right pane's tab state, driven through the REAL hook. Its thread
// half (the Replies toggle and the remembered root — QA D-1, 2026-09-22) went
// with the thread tab: threads open inline under their message (web redesign
// Phase 2). What is left, and pinned here, is the entry rule and the 🧠.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  matchMedia: dom.window.matchMedia,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia = () => ({
  matches: true, // desktop: the lg breakpoint is met
  addEventListener() {},
  removeEventListener() {},
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDmRightPane } = await import("./useDmRightPane.ts");

const { useState } = React;

/** A route-shaped harness: the conversation and its agent-DM flag. */
function Probe({ onPane }) {
  const [channelId, setChannelId] = useState("A");
  const [agentDm, setAgentDm] = useState(true);
  const pane = useDmRightPane({ agentDm, channelId, ownerPubkey: "owner" });
  onPane({ ...pane, channelId, setChannelId, setAgentDm });
  return null;
}

async function mount() {
  globalThis.localStorage?.clear?.();
  dom.window.localStorage.clear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest;
  await act(async () => {
    root.render(React.createElement(Probe, { onPane: (p) => (latest = p) }));
  });
  return {
    root,
    container,
    get pane() {
      return latest;
    },
  };
}

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.act,
  });
  dom.window.matchMedia = originals.matchMedia;
});

test("the pane starts closed; once shown, entering an agent DM selects Thinking once and picking Work sticks", async () => {
  const h = await mount();
  try {
    // Closed by default (plan item 1): entry leaves Work selected.
    assert.equal(h.pane.dmPaneHidden, true);
    assert.equal(h.pane.panes.thinkingVisible, false);
    assert.equal(h.pane.active, "work");
    await act(async () => h.pane.panes.toggleThinking()); // show
    assert.equal(h.pane.active, "activity", "the 🧠 selects the thinking tab");
    assert.equal(h.pane.panes.thinkingVisible, true);
    await act(async () => h.pane.selectTab("work"));
    assert.equal(h.pane.active, "work");
    assert.equal(h.pane.panes.thinkingVisible, false);
    // Re-entering the same conversation's render does not steal it back…
    await act(async () => h.pane.setChannelId("A"));
    assert.equal(h.pane.active, "work");
    // …entering ANOTHER agent DM does.
    await act(async () => h.pane.setChannelId("B"));
    assert.equal(h.pane.active, "activity");
  } finally {
    await act(async () => h.root.unmount());
    h.container.remove();
  }
});

test("the 🧠 round-trips, and closing Thinking lands on Work", async () => {
  const h = await mount();
  try {
    await act(async () => h.pane.panes.toggleThinking()); // show
    assert.equal(h.pane.panes.thinkingVisible, true);
    await act(async () => h.pane.panes.toggleThinking()); // hide
    assert.equal(h.pane.panes.thinkingVisible, false);
    assert.equal(h.pane.dmPaneHidden, true);
    assert.equal(h.pane.active, "work");
    await act(async () => h.pane.panes.toggleThinking()); // show
    assert.equal(h.pane.panes.thinkingVisible, true);
    assert.equal(h.pane.active, "activity");
    await act(async () => h.pane.closeThinking());
    assert.equal(h.pane.active, "work");
    assert.equal(h.pane.dmPaneHidden, true);
  } finally {
    await act(async () => h.root.unmount());
    h.container.remove();
  }
});

test("the hook's surface has no thread half left", async () => {
  const h = await mount();
  try {
    for (const gone of [
      "openThreadTab",
      "closeThread",
      "threadsVisible",
      "threadsAvailable",
      "toggleThreads",
    ]) {
      assert.equal(gone in h.pane, false, gone);
      assert.equal(gone in h.pane.panes, false, `panes.${gone}`);
    }
  } finally {
    await act(async () => h.root.unmount());
    h.container.remove();
  }
});
