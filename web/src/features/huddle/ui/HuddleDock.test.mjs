import assert from "node:assert/strict";
import { test, after } from "node:test";

// The DOCK VISIBILITY RULE, mounted for real under jsdom + act.
//
// "Stays docked to that dm or channel" (Sam, 2026-09-18) is the one rule
// that cannot be checked by reading the component: it is a conjunction of
// three live values, and getting it wrong in either direction is invisible
// in a unit sense — too eager and a call follows you everywhere, too shy
// and a live microphone has no surface at all. The registration assertions
// below are the other half of that: the pill only appears because the dock
// tells the provider it is gone.

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

const HUDDLE = "eph-huddle-1";
const PARENT = "dm-parent-1";
const ELSEWHERE = "some-other-channel";

/** What the stubbed provider hands the dock; each test rewrites it. */
globalThis.__BUZZ_TEST_HUDDLE_SESSION__ = null;
/** Every setDockMounted(bool) the dock made, in order. */
globalThis.__BUZZ_TEST_DOCK_REGISTRATIONS__ = [];

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  // The provider is the seam: the dock reads one session object from it.
  "../HuddleSessionProvider.tsx": `
    export function useHuddleSession() {
      return globalThis.__BUZZ_TEST_HUDDLE_SESSION__;
    }
  `,
  // The control row is composition, not this rule; mounting it would drag
  // in radix menus, the emoji picker and the relay session for nothing.
  // No imports in a stub: a stub module has no file URL, so even "react"
  // cannot be resolved from inside one. React arrives through a global the
  // test sets before the component under test is imported.
  "./HuddleControls.tsx": `
    export function HuddleControls({ variant }) {
      return globalThis.__BUZZ_TEST_REACT__.createElement("div", {
        "data-testid": "huddle-controls-" + variant,
      });
    }
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HuddleDock } = await import("./HuddleDock.tsx");

function session({ connected = true, floating = false, ...overrides } = {}) {
  return {
    floating,
    setFloating: () => {},
    setDockMounted: (mounted) =>
      globalThis.__BUZZ_TEST_DOCK_REGISTRATIONS__.push(mounted),
    active: { huddleChannelId: HUDDLE, parentChannelId: PARENT },
    call: {
      connected,
      reconnecting: false,
      channelId: HUDDLE,
      parentChannelId: PARENT,
      micHoldNotice: null,
      huddle: { micLevel: -50, muted: false, error: null },
      voice: { enabled: false, interimText: "", error: null },
      reactions: { active: [] },
      ...overrides,
    },
  };
}

async function mountDock(currentChannelId, sessionValue) {
  globalThis.__BUZZ_TEST_HUDDLE_SESSION__ = sessionValue ?? session();
  globalThis.__BUZZ_TEST_DOCK_REGISTRATIONS__ = [];
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HuddleDock, { currentChannelId }));
  });
  return {
    container,
    docked: () =>
      container.querySelectorAll('[data-testid="huddle-dock"]').length,
    registrations: () => globalThis.__BUZZ_TEST_DOCK_REGISTRATIONS__,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("the dock renders on the huddle's own channel", async () => {
  const mounted = await mountDock(HUDDLE);
  assert.equal(mounted.docked(), 1);
  assert.equal(
    mounted.container.querySelectorAll('[data-testid="huddle-controls-dock"]')
      .length,
    1,
    "...carrying the shared control row",
  );
  await mounted.unmount();
});

test("the dock renders on the huddle's PARENT channel", async () => {
  const mounted = await mountDock(PARENT);
  assert.equal(mounted.docked(), 1);
  await mounted.unmount();
});

test("the dock does NOT render on any other channel", async () => {
  // The discriminating case. A dock that follows the reader everywhere is
  // exactly what "stays docked to that dm or channel" rules out.
  const mounted = await mountDock(ELSEWHERE);
  assert.equal(mounted.docked(), 0);
  assert.equal(
    mounted.registrations().length,
    0,
    "an invisible dock must not claim the pill's slot",
  );
  await mounted.unmount();
});

test("the dock yields to the floating panel, even on its own channel", async () => {
  const mounted = await mountDock(HUDDLE, session({ floating: true }));
  assert.equal(mounted.docked(), 0);
  await mounted.unmount();
});

test("a call that is not connected has no dock", async () => {
  const mounted = await mountDock(HUDDLE, session({ connected: false }));
  assert.equal(mounted.docked(), 0);
  await mounted.unmount();
});

test("the dock registers on mount and DEregisters on unmount — the pill's trigger", async () => {
  const mounted = await mountDock(HUDDLE);
  assert.deepEqual(mounted.registrations(), [true]);
  await mounted.unmount();
  assert.deepEqual(
    mounted.registrations(),
    [true, false],
    "without the deregister the pill never returns and the call goes dark",
  );
});

test("the dock surfaces reconnecting, the mic hold and the interim transcript", async () => {
  const mounted = await mountDock(
    HUDDLE,
    session({
      reconnecting: true,
      micHoldNotice: "Mic paused while Evie speaks",
      voice: { enabled: true, interimText: "hang on a second", error: null },
    }),
  );
  const text = mounted.container.textContent;
  assert.match(text, /Reconnecting/);
  assert.match(text, /Mic paused while Evie speaks/);
  assert.match(text, /hang on a second/);
  assert.equal(
    mounted.container.querySelectorAll('[data-testid="huddle-mic-hold"]')
      .length,
    1,
  );
  assert.equal(
    mounted.container.querySelectorAll('[data-testid="huddle-voice-interim"]')
      .length,
    1,
  );
  await mounted.unmount();
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
