import assert from "node:assert/strict";
import { test } from "node:test";

// DetachedThreadPanel — the thread kept open beside ANOTHER conversation or
// a full-page view. The boundaries (feed, send, roster, relay/huddle
// sessions) are stubbed; ThreadPanel is stubbed to capture the props the
// detached pane hands it, which is exactly the contract under test: it must
// always pass an `origin` naming the thread's channel and jumping to it (the
// ThreadPanel suite proves what `origin` renders).
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = {
  id: "root-1",
  authorPubkey: "a".repeat(64),
  createdAt: 1_000,
  content: "root",
};
const BOB = "b".repeat(64);
const SELF = "e".repeat(64);

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "./ThreadPanel": `
    export function ThreadPanel(props) {
      globalThis.__THREAD_PANEL_PROPS__ = props;
      return null;
    }
  `,
  "@/features/channels/hooks": `
    export function useChannelMessages() {
      return { messages: globalThis.__FEED__ };
    }
    export function useProfiles() {
      return globalThis.__PROFILES__;
    }
  `,
  "@/features/channels/lib/useMessageActions.ts": `
    export function useMessageActions() {
      return { send: async () => ({ ok: true, message: "" }) };
    }
  `,
  "@/features/huddle/HuddleSessionProvider": `
    export function useHuddleSession() {
      return { call: { channelId: null, memberPubkeys: [], memberRosterKnown: false } };
    }
  `,
  "@/features/huddle/useHuddleMentionMembers": `
    export function useRouteMentionMembers() {
      return { members: [], strictMentions: false };
    }
  `,
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: {} };
    }
  `,
};
globalThis.__FEED__ = [ROOT];
globalThis.__PROFILES__ = new Map([[BOB, { name: "bob", displayName: "Bob" }]]);

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DetachedThreadPanel } = await import("./DetachedThreadPanel.tsx");

async function render(channel) {
  globalThis.__THREAD_PANEL_PROPS__ = undefined;
  let opened = 0;
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(DetachedThreadPanel, {
        channel,
        rootId: ROOT.id,
        selfPubkey: SELF,
        agentPubkeys: new Set(),
        onClose: () => {},
        onOpenChannel: () => {
          opened += 1;
        },
      }),
    );
  });
  const props = globalThis.__THREAD_PANEL_PROPS__;
  await act(async () => root.unmount());
  return { props, opened: () => opened };
}

test("a kept-open channel thread names its channel and links to it", async () => {
  const { props, opened } = await render({
    id: "general-id",
    name: "general",
    type: "stream",
    participantPubkeys: [],
  });
  assert.ok(props, "the thread rendered");
  assert.equal(props.origin?.label, "#general");
  props.origin.onOpen();
  assert.equal(opened(), 1, "the label jumps to the thread's channel");
});

test("a kept-open DM thread is labelled by the other participant", async () => {
  const { props } = await render({
    id: "dm-id",
    name: "DM",
    type: "dm",
    participantPubkeys: [SELF, BOB],
  });
  assert.equal(props.origin?.label, "Bob");
});
