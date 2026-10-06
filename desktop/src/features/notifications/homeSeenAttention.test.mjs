import assert from "node:assert/strict";
import { after, test } from "node:test";

import { JSDOM } from "jsdom";

// Invariant I3 for Home: an open-but-unattended Home must neither mark its
// feed seen (persisted seen-set) nor hide the dock badge.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://desktop.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const page = { visibility: "hidden", focused: false };
Object.defineProperty(dom.window.document, "visibilityState", {
  configurable: true,
  get: () => page.visibility,
});
dom.window.document.hasFocus = () => page.focused;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useHomeFeedNotificationState } = await import("./hooks.ts");

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    localStorage: originals.localStorage,
    IS_REACT_ACT_ENVIRONMENT: originals.act,
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function setPage(visibility, focused) {
  await act(async () => {
    page.visibility = visibility;
    page.focused = focused;
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    dom.window.dispatchEvent(new dom.window.Event(focused ? "focus" : "blur"));
    await settle();
    await settle();
  });
}

const PUBKEY = "a".repeat(64);
const feed = {
  feed: {
    mentions: [
      {
        id: "mention-1",
        kind: 9,
        pubkey: "b".repeat(64),
        content: "hi",
        createdAt: 100,
        channelId: null,
        channelName: "",
        tags: [],
        category: "mention",
      },
    ],
    needsAction: [],
    activity: [],
    agentActivity: [],
  },
};
const settings = {
  desktopEnabled: false,
  homeBadgeEnabled: true,
  notifyWhileViewing: false,
  sounds: {},
  slotAlertsEnabled: { mention: false, needs_action: false },
  slotAlertsSnapshot: null,
};
const NO_CHANNELS = new Set();

test("I3 Home: unattended Home keeps the badge and does not mark the feed seen", async () => {
  await setPage("hidden", false);
  const results = [];
  const Probe = () => {
    results.push(
      useHomeFeedNotificationState(
        feed,
        PUBKEY,
        settings,
        async () => false,
        false,
        true, // isHomeActive: Home is the open view
        () => null,
        0,
        NO_CHANNELS,
      ).homeBadgeCount,
    );
    return null;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
    await settle();
  });
  assert.equal(results.at(-1), 1, "unattended: badge still counts the item");

  await setPage("visible", true);
  assert.equal(results.at(-1), 0, "attended Home: item seen, badge clears");

  // Seen persists: leaving attention again does not resurrect it.
  await setPage("hidden", false);
  assert.equal(results.at(-1), 0);
  await act(async () => root.unmount());
});
