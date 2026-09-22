import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

// D-1 (QA, 2026-09-22): opening a thread in conversation A and switching to
// B left the Replies button enabled in B — `lastThreadRootId` survived the
// switch, so clicking it restored A's root, which cannot resolve in B: the
// pane never mounted while the policy still reported it visible
// (aria-pressed=true, "Hide replies panel", no pane).

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
dom.window.matchMedia = (query) => ({
  matches: true, // desktop: the lg breakpoint is met
  addEventListener() {},
  removeEventListener() {},
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDmRightPane } = await import("./useDmRightPane.ts");

const { useState } = React;

/**
 * A route-shaped harness: threadRootId lives in the parent (like repos.tsx),
 * and a channelId change simulates selectChannel (which nulls the root).
 */
function Probe({ onPane }) {
  const [channelId, setChannelId] = useState("A");
  const [threadRootId, setThreadRootId] = useState(null);
  const pane = useDmRightPane({
    agentDm: true,
    channelId,
    threadRootId,
    setThreadRootId,
  });
  onPane({ ...pane, channelId, threadRootId, setChannelId, setThreadRootId });
  return null;
}

async function mount() {
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

test("the remembered thread root does not survive a channel switch (D-1)", async () => {
  const h = await mount();
  try {
    // Open a thread in A and show it via the toggle.
    await act(async () => h.pane.setThreadRootId("root-A"));
    assert.equal(h.pane.panes.threadsAvailable, true);
    await act(async () => h.pane.panes.toggleThreads()); // show (tab flips)
    assert.equal(h.pane.panes.threadsVisible, true);
    await act(async () => h.pane.panes.toggleThreads()); // hide
    assert.equal(h.pane.panes.threadsVisible, false);
    assert.equal(
      h.pane.panes.threadsAvailable,
      true,
      "same channel: the hidden thread stays restorable",
    );

    // Switch to B the way selectChannel does: clear the root, change the
    // channel. The button must go DISABLED — there is no thread to show in B.
    await act(async () => {
      h.pane.setThreadRootId(null);
      h.pane.setChannelId("B");
    });
    assert.equal(
      h.pane.panes.threadsAvailable,
      false,
      "phantom-pressed button: the remembered root leaked across the switch",
    );
    assert.equal(h.pane.panes.threadsVisible, false);
  } finally {
    await act(async () => h.root.unmount());
    h.container.remove();
  }
});

test("within one channel the toggle round-trips through the remembered root", async () => {
  const h = await mount();
  try {
    await act(async () => h.pane.setThreadRootId("root-A"));
    await act(async () => h.pane.panes.toggleThreads()); // show
    assert.equal(h.pane.panes.threadsVisible, true);
    await act(async () => h.pane.panes.toggleThreads()); // hide
    assert.equal(h.pane.panes.threadsVisible, false);
    await act(async () => h.pane.panes.toggleThreads()); // show again
    assert.equal(h.pane.panes.threadsVisible, true);
    assert.equal(h.pane.threadRootId, "root-A"); // the route's root was restored
  } finally {
    await act(async () => h.root.unmount());
    h.container.remove();
  }
});

test("a deep-link thread opened while switching into a channel is remembered", async () => {
  const h = await mount();
  try {
    // Permalink into B with a root resolved in the same update.
    await act(async () => {
      h.pane.setChannelId("B");
      h.pane.setThreadRootId("root-B");
    });
    assert.equal(h.pane.panes.threadsAvailable, true);
    await act(async () => h.pane.panes.toggleThreads()); // show
    assert.equal(h.pane.panes.threadsVisible, true);
    await act(async () => h.pane.panes.toggleThreads()); // hide
    assert.equal(
      h.pane.panes.threadsAvailable,
      true,
      "same channel: still restorable",
    );
  } finally {
    await act(async () => h.root.unmount());
    h.container.remove();
  }
});
