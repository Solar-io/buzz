import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

// I3 on the REAL hook: a read marker advances only for a conversation that
// is on screen — tab visible, window focused, nothing covering it — and a
// conversation that was hidden is marked the moment it becomes visible.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The page's attention, driven by the test exactly as a browser drives it:
// the property changes, then the event fires.
const page = { visibility: "hidden", focused: false };
Object.defineProperty(dom.window.document, "visibilityState", {
  configurable: true,
  get: () => page.visibility,
});
dom.window.document.hasFocus = () => page.focused;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useMarkShownSeen } = await import("./useMarkShownSeen.ts");

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.act,
  });
});

async function setPage(visibility, focused) {
  await act(async () => {
    page.visibility = visibility;
    page.focused = focused;
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    dom.window.dispatchEvent(new dom.window.Event(focused ? "focus" : "blur"));
  });
}

async function mount(props) {
  const marks = [];
  const markSeen = (id, at) => marks.push([id, at]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Probe = (p) => {
    useMarkShownSeen({ ...p, markSeen });
    return null;
  };
  const render = async (next) =>
    act(async () => root.render(React.createElement(Probe, next)));
  await render(props);
  return { marks, render, unmount: () => act(async () => root.unmount()) };
}

test("I3: a hidden tab never moves the marker; becoming visible and focused marks it then", async () => {
  await setPage("hidden", false);
  const h = await mount({
    channelId: "dm-1",
    newestMessageAt: 100,
    shown: true,
  });
  assert.deepEqual(h.marks, [], "hidden tab: no marker move");

  // A new message arrives while hidden — still nothing.
  await h.render({ channelId: "dm-1", newestMessageAt: 200, shown: true });
  assert.deepEqual(h.marks, []);

  await setPage("visible", true);
  assert.deepEqual(h.marks, [["dm-1", 200]], "marked the moment it is seen");
  await h.unmount();
});

test("I3: a visible but UNFOCUSED window does not mark (another app has focus)", async () => {
  await setPage("visible", false);
  const h = await mount({
    channelId: "dm-2",
    newestMessageAt: 50,
    shown: true,
  });
  assert.deepEqual(h.marks, []);
  await setPage("visible", true);
  assert.deepEqual(h.marks, [["dm-2", 50]]);
  await h.unmount();
});

test("I3: a conversation covered by a web view (not shown) is not marked until uncovered", async () => {
  await setPage("visible", true);
  const h = await mount({
    channelId: "c-1",
    newestMessageAt: 70,
    shown: false,
  });
  assert.deepEqual(h.marks, []);
  await h.render({ channelId: "c-1", newestMessageAt: 70, shown: true });
  assert.deepEqual(h.marks, [["c-1", 70]]);
  await h.unmount();
});

test("I3: on screen, every newer message is marked as it lands", async () => {
  await setPage("visible", true);
  const h = await mount({ channelId: "c-2", newestMessageAt: 10, shown: true });
  await h.render({ channelId: "c-2", newestMessageAt: 11, shown: true });
  assert.deepEqual(h.marks, [
    ["c-2", 10],
    ["c-2", 11],
  ]);
  await h.unmount();
});

test("I3: in the iOS app, foreground visibility alone is attention (WKWebView focus is not)", async () => {
  globalThis.Capacitor = { isNativePlatform: () => true };
  try {
    await setPage("visible", false);
    const h = await mount({
      channelId: "dm-3",
      newestMessageAt: 5,
      shown: true,
    });
    assert.deepEqual(h.marks, [["dm-3", 5]]);
    await setPage("hidden", false);
    await h.render({ channelId: "dm-3", newestMessageAt: 6, shown: true });
    assert.deepEqual(h.marks, [["dm-3", 5]], "backgrounded app: no mark");
    await h.unmount();
  } finally {
    delete globalThis.Capacitor;
  }
});
