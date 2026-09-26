import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

// Plan item 1 (Sam, 2026-09-26): the desktop thinking pane starts CLOSED and
// remembers each user's open/closed choice across reloads.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: dom.window.localStorage,
});
dom.window.matchMedia = () => ({
  matches: true, // desktop
  addEventListener() {},
  removeEventListener() {},
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDmRightPane } = await import("./useDmRightPane.ts");
const {
  THINKING_PANE_HIDDEN_PREFIX,
  loadThinkingPaneHidden,
  saveThinkingPaneHidden,
} = await import("./lib/thinkingPanePref.ts");

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.act;
  if (originals.localStorage) {
    Object.defineProperty(globalThis, "localStorage", originals.localStorage);
  } else {
    delete globalThis.localStorage;
  }
});

async function mount(ownerPubkey) {
  let latest;
  function Probe() {
    latest = useDmRightPane({
      agentDm: true,
      channelId: "dm",
      threadRootId: null,
      setThreadRootId: () => {},
      ownerPubkey,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Probe)));
  return {
    get pane() {
      return latest;
    },
    act: (fn) => act(async () => fn()),
    unmount: () => act(async () => root.unmount()),
  };
}

test("pref: hidden by default, per pubkey, and unknown owner stays hidden", () => {
  const storage = dom.window.localStorage;
  storage.clear();
  assert.equal(loadThinkingPaneHidden(storage, "me"), true);
  saveThinkingPaneHidden(storage, "me", false);
  assert.equal(storage.getItem(`${THINKING_PANE_HIDDEN_PREFIX}me`), "0");
  assert.equal(loadThinkingPaneHidden(storage, "me"), false);
  assert.equal(loadThinkingPaneHidden(storage, "other"), true);
  assert.equal(loadThinkingPaneHidden(storage, null), true);
  saveThinkingPaneHidden(storage, null, false);
  assert.equal(storage.length, 1, "no write without an owner");
});

test("an agent DM opens with the thinking pane CLOSED", async () => {
  dom.window.localStorage.clear();
  const h = await mount("me");
  try {
    assert.equal(h.pane.dmPaneHidden, true);
    assert.equal(h.pane.panes.thinkingVisible, false);
  } finally {
    await h.unmount();
  }
});

test("the 🧠 toggle's choice survives a reload, for that user only", async () => {
  dom.window.localStorage.clear();
  const first = await mount("me");
  await first.act(() => first.pane.panes.toggleThinking());
  assert.equal(first.pane.dmPaneHidden, false, "opened");
  await first.unmount();

  const reload = await mount("me");
  assert.equal(reload.pane.dmPaneHidden, false, "still open after reload");
  await reload.act(() => reload.pane.setDmPaneHidden(true));
  await reload.unmount();

  const again = await mount("me");
  assert.equal(again.pane.dmPaneHidden, true, "closed choice sticks too");
  await again.unmount();

  const someoneElse = await mount("other");
  assert.equal(someoneElse.pane.dmPaneHidden, true);
  await someoneElse.unmount();
});
