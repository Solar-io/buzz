import assert from "node:assert/strict";
import { test, after } from "node:test";

// The floating huddle panel, mounted for real under jsdom + act.
//
// Sam, 2026-10-01: the panel's "Call transcript" box is gone. The relay
// mirrors every call line into the parent channel / DM as it lands, so the
// panel timeline only repeated the main chat. The panel keeps the
// participant grid, a composer into the call room, and the control row.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Every call-room feed a mounted component subscribed to. */
globalThis.__BUZZ_TEST_ROOM_FEED_READS__ = [];
globalThis.__BUZZ_TEST_HUDDLE_SESSION__ = {
  floating: true,
  setFloating: () => {},
  call: {
    channelId: "eph-huddle-1",
    parentChannelId: "dm-parent-1",
    selfPubkey: "1".repeat(64),
    memberPubkeys: ["1".repeat(64)],
    send: () => {},
    micHoldNotice: null,
    voice: { enabled: false, interimText: "", error: null },
    reactions: { active: [] },
    profiles: new Map(),
  },
};

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../HuddleSessionProvider.tsx": `
    export function useHuddleSession() {
      return globalThis.__BUZZ_TEST_HUDDLE_SESSION__;
    }
  `,
  // Composition seams: each renders a marker so the test can see the panel
  // still carries it. No imports in a stub (no file URL to resolve from).
  "./HuddleControls.tsx": `
    export function HuddleControls({ variant }) {
      return globalThis.__BUZZ_TEST_REACT__.createElement("div", {
        "data-testid": "huddle-controls-" + variant,
      });
    }
  `,
  "./HuddleComposer.tsx": `
    export function HuddleComposer() {
      return globalThis.__BUZZ_TEST_REACT__.createElement("div", {
        "data-testid": "huddle-composer",
      });
    }
  `,
  "./HuddleReactionBurst.tsx": `
    export function HuddleReactionBurst() { return null; }
  `,
  "./HuddleParticipants.tsx": `
    export function huddleParticipants() { return []; }
    export function HuddleParticipantCards() {
      return globalThis.__BUZZ_TEST_REACT__.createElement("div", {
        "data-testid": "huddle-participant-cards",
      });
    }
  `,
  // The call room's feed and timeline, stubbed so that ANY transcript put
  // back into the panel mounts cheaply and is caught by the assertions
  // below rather than by an import failure.
  "@/features/channels/hooks": `
    export function useChannelMessages(channelId) {
      globalThis.__BUZZ_TEST_ROOM_FEED_READS__.push(channelId);
      return { messages: [], reactions: new Map(), loadOlder: () => {},
        loadingOlder: false, historyExhausted: true };
    }
    export function useProfiles() { return new Map(); }
  `,
  "@/features/channels/ui/ChannelTimeline": `
    export function ChannelTimeline() {
      return globalThis.__BUZZ_TEST_REACT__.createElement("div", {
        "data-testid": "call-room-timeline",
      });
    }
  `,
  "@/features/channels/ui/Composer": `
    export function Composer() { return null; }
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HuddleFloatingPanel } = await import("./HuddleFloatingPanel.tsx");

async function mountPanel() {
  globalThis.__BUZZ_TEST_ROOM_FEED_READS__ = [];
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HuddleFloatingPanel));
  });
  return {
    container,
    has: (testid) =>
      container.querySelectorAll(`[data-testid="${testid}"]`).length,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the floating panel keeps participants, composer and controls", async () => {
  const panel = await mountPanel();
  assert.equal(panel.has("huddle-floating-panel"), 1);
  assert.equal(panel.has("huddle-participant-cards"), 1);
  assert.equal(panel.has("huddle-composer"), 1);
  assert.equal(panel.has("huddle-controls-panel"), 1);
  await panel.unmount();
});

test("the floating panel has no call transcript box", async () => {
  const panel = await mountPanel();
  assert.equal(panel.has("huddle-floating-panel"), 1, "the panel renders");
  assert.equal(
    panel.container.querySelectorAll(
      '[aria-label="Call transcript"], [data-testid="huddle-chat"], [data-testid="call-room-timeline"]',
    ).length,
    0,
  );
  assert.doesNotMatch(panel.container.textContent, /transcript/i);
  assert.deepEqual(
    globalThis.__BUZZ_TEST_ROOM_FEED_READS__,
    [],
    "the panel does not read the call room's messages at all",
  );
  await panel.unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});
