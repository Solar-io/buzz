import assert from "node:assert/strict";
import { test, after } from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
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

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/features/huddle/useHuddleRoster": `
    export function useHuddleRoster() { return { live: [] }; }
  `,
  "./ChannelMembersButton.tsx": `
    export function ChannelMembersButton() { return null; }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChannelActionsBar } = await import("./ChannelActionsBar.tsx");

const SELF = "1".repeat(64);
const AGENT = "2".repeat(64);

function channel(type) {
  return {
    id: `${type}-1`,
    name: type,
    about: "",
    updatedAt: 0,
    type,
    archived: false,
    isPrivate: false,
    topic: "",
    purpose: "",
    ttlDeadline: null,
    ttlSeconds: null,
    participantPubkeys: type === "dm" ? [SELF, AGENT] : [],
  };
}

async function mount(props) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ChannelActionsBar, props));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function props(overrides = {}) {
  return {
    channel: channel("dm"),
    title: "Evie",
    agentPubkey: AGENT,
    onOpenThinking: () => {},
    onStartAgentCall: async () => ({ ok: true, message: "started" }),
    selfPubkey: SELF,
    ...overrides,
  };
}

test("one click invokes the DM call action and leaves the DM in place", async () => {
  const calls = [];
  const mounted = await mount(
    props({
      onStartAgentCall: async (roomId) => {
        calls.push(roomId);
        return { ok: true, message: "started" };
      },
    }),
  );

  await act(async () => {
    mounted.container
      .querySelector('[data-testid="dm-start-call"]')
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(calls, [null]);
  await mounted.unmount();
});

test("a pending DM call button rejects a second click", async () => {
  const calls = [];
  let resolveCall;
  const pending = new Promise((resolve) => {
    resolveCall = resolve;
  });
  const mounted = await mount(
    props({
      onStartAgentCall: () => {
        calls.push(true);
        return pending;
      },
    }),
  );
  const button = mounted.container.querySelector(
    '[data-testid="dm-start-call"]',
  );

  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(calls.length, 1);
  assert.equal(button.disabled, true);
  resolveCall({ ok: true, message: "started" });
  await act(async () => pending);
  await mounted.unmount();
});

test("regular channels and non-agent DMs have no call entry", async () => {
  const regular = await mount(
    props({ channel: channel("stream"), agentPubkey: null }),
  );
  assert.equal(
    regular.container.querySelector('[data-testid="dm-start-call"]'),
    null,
  );
  await regular.unmount();

  const humanDm = await mount(
    props({ agentPubkey: null, onStartAgentCall: undefined }),
  );
  assert.equal(
    humanDm.container.querySelector('[data-testid="dm-start-call"]'),
    null,
  );
  await humanDm.unmount();
});

test("the thinking toggle appears only on an agent DM and opens the pane", async () => {
  // The 🧠 moved here from the deleted ChannelHeader (Sam, 2026-09-22). Its
  // gate is the same one the Call button uses — a non-null agentPubkey — and
  // that gate is the thing worth pinning: a human DM must not grow a toggle
  // that would open a pane with nothing to show.
  const opened = [];
  const agentDm = await mount(
    props({ onOpenThinking: () => opened.push(true) }),
  );
  const toggle = agentDm.container.querySelector(
    '[data-testid="toggle-thinking-panel"]',
  );
  assert.ok(toggle, "an agent DM renders the thinking toggle");
  await act(async () => {
    toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(opened, [true], "clicking it reveals the thinking pane");
  await agentDm.unmount();

  const regular = await mount(
    props({ channel: channel("stream"), agentPubkey: null }),
  );
  assert.equal(
    regular.container.querySelector('[data-testid="toggle-thinking-panel"]'),
    null,
    "a regular channel has no thinking toggle",
  );
  await regular.unmount();

  const humanDm = await mount(props({ agentPubkey: null }));
  assert.equal(
    humanDm.container.querySelector('[data-testid="toggle-thinking-panel"]'),
    null,
    "a human DM has no thinking toggle",
  );
  await humanDm.unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});
