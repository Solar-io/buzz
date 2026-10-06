import assert from "node:assert/strict";
import { after, test } from "node:test";

import { JSDOM } from "jsdom";

// Invariant I3 on the REAL hooks: automatic read-marker advances happen only
// while the window is visible AND focused. The desktop app runs 24/7 as the
// agent host with a conversation open and nobody looking; without this gate
// it marked every arrival read and NIP-RS cleared the unread dot on the
// user's other devices while their toast was still on screen.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://desktop.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Window attention, driven the way WKWebView drives it: the property changes,
// then the event fires.
const page = { visibility: "hidden", focused: false };
Object.defineProperty(dom.window.document, "visibilityState", {
  configurable: true,
  get: () => page.visibility,
});
dom.window.document.hasFocus = () => page.focused;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppShellProvider } = await import("@/app/AppShellContext");
const { useChannelOpenReadState } = await import(
  "./useChannelOpenReadState.ts"
);
const { useHuddleReadMarker } = await import("./useHuddleReadMarker.ts");
const { useChannelUnreadState } = await import("./useChannelUnreadState.ts");

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.act,
  });
});

// Regained focus resolves after scheduleAfterForegroundReady's
// task -> frame -> task chain; let it drain.
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

async function mountProbe(Probe, props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next) =>
    act(async () => {
      root.render(React.createElement(Probe, next));
      await settle();
    });
  await render(props);
  return { render, unmount: () => act(async () => root.unmount()) };
}

// --- useChannelOpenReadState (the open conversation) -----------------------

function mountOpenReadState(props) {
  const marks = [];
  const undone = [];
  const shell = {
    feedItemState: { undoUnread: (id) => undone.push(id) },
    locallyUnreadFeedItems: [{ id: "feed-1", channelId: "dm-1", tags: [] }],
    markChannelRead: (channelId, readAt) => marks.push([channelId, readAt]),
  };
  const Inner = ({ channelId, readAt }) => {
    useChannelOpenReadState(channelId, true, readAt);
    return null;
  };
  const Probe = (p) =>
    React.createElement(AppShellProvider, {
      value: shell,
      children: React.createElement(Inner, p),
    });
  return mountProbe(Probe, props).then((h) => ({ ...h, marks, undone }));
}

test("I3 open conversation: a hidden window never marks; regaining attention marks the newest then", async () => {
  await setPage("hidden", false);
  const h = await mountOpenReadState({ channelId: "dm-1", readAt: "t1" });
  assert.deepEqual(h.marks, [], "hidden: no marker move");
  assert.deepEqual(h.undone, [], "hidden: inbox override not consumed");

  // A new DM lands while nobody is looking.
  await h.render({ channelId: "dm-1", readAt: "t2" });
  assert.deepEqual(h.marks, [], "arrival while hidden stays unread");

  await setPage("visible", true);
  assert.deepEqual(h.marks, [["dm-1", "t2"]], "marked when seen, at newest");
  assert.deepEqual(h.undone, ["feed-1"]);
  await h.unmount();
});

test("I3 open conversation: visible but UNFOCUSED (another app / Space) does not mark", async () => {
  await setPage("visible", false);
  const h = await mountOpenReadState({ channelId: "dm-1", readAt: "t5" });
  await h.render({ channelId: "dm-1", readAt: "t6" });
  assert.deepEqual(h.marks, []);
  await setPage("visible", true);
  assert.deepEqual(h.marks, [["dm-1", "t6"]]);
  await h.unmount();
});

test("I3 open conversation: while attended, each arrival is marked as it lands", async () => {
  await setPage("visible", true);
  const h = await mountOpenReadState({ channelId: "c-1", readAt: "t1" });
  await h.render({ channelId: "c-1", readAt: "t2" });
  assert.deepEqual(h.marks, [
    ["c-1", "t1"],
    ["c-1", "t2"],
  ]);
  // Focus lost mid-conversation: the next arrival is NOT marked.
  await setPage("visible", false);
  await h.render({ channelId: "c-1", readAt: "t3" });
  assert.equal(h.marks.length, 2, "blurred window: arrival stays unread");
  await h.unmount();
});

// --- useHuddleReadMarker ----------------------------------------------------

test("I3 huddle marker: no mark while unattended; marks on return", async () => {
  await setPage("hidden", false);
  const marks = [];
  const markChannelRead = (channelId, readAt) =>
    marks.push([channelId, readAt]);
  const messages = [{ id: "m1", created_at: 100, tags: [] }];
  const Probe = (p) => {
    useHuddleReadMarker({
      activeChannelId: "h-1",
      activeChannelIsMember: true,
      isHuddleTranscript: false,
      markChannelRead,
      messages: p.messages,
      resolvedMessages: p.messages,
    });
    return null;
  };
  const h = await mountProbe(Probe, { messages });
  assert.deepEqual(marks, []);
  await setPage("visible", true);
  assert.deepEqual(marks, [["h-1", new Date(100_000).toISOString()]]);
  await h.unmount();
});

// --- useChannelUnreadState: replies in an OPEN thread -----------------------

test("I3 open thread: replies are not marked read until the window is attended", async () => {
  await setPage("hidden", false);
  const marks = [];
  const markMessageRead = (id, at) => marks.push([id, at]);
  const reply = (id, createdAt) => ({
    message: { id, createdAt, pubkey: "other", kind: 9, tags: [] },
  });
  const Probe = (p) => {
    useChannelUnreadState({
      activeChannelId: "c-1",
      timelineMessages: [],
      currentPubkey: "me",
      openThreadHeadId: "root",
      threadReplyTargetId: null,
      expandedThreadReplyIds: new Set(),
      openThreadMessages: p.replies,
      getChannelReadAt: () => null,
      getMessageReadAt: () => null,
      clearChannelUnreadSource: () => {},
      markChannelUnread: () => {},
      markMessageRead,
      isThreadMuted: () => false,
      readStateVersion: 0,
    });
    return null;
  };
  const r1 = reply("r1", 10);
  const h = await mountProbe(Probe, { replies: [r1] });
  await h.render({ replies: [r1, reply("r2", 20)] });
  assert.deepEqual(marks, [], "unattended thread: no reply marked");

  await setPage("visible", true);
  assert.deepEqual(marks, [
    ["r1", 10],
    ["r2", 20],
  ]);
  await h.unmount();
});
