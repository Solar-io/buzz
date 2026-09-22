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
    panes: {
      thinkingVisible: false,
      toggleThinking: () => {},
      threadsVisible: false,
      threadsAvailable: false,
      toggleThreads: () => {},
    },
    dictation: undefined,
    onStartAgentCall: async () => ({ ok: true, message: "started" }),
    selfPubkey: SELF,
    ...overrides,
  };
}

/** A dictation controller stub — the hook's contract as the bar sees it. */
function dictationController(overrides = {}) {
  const controller = {
    supported: true,
    active: false,
    interimText: "",
    error: null,
    toggles: 0,
    toggle: () => {
      controller.toggles += 1;
    },
    ...overrides,
  };
  return controller;
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

test("the thinking toggle appears only on an agent DM and is two-way", async () => {
  // The 🧠 moved here from the deleted ChannelHeader (Sam, 2026-09-22), and
  // became a TOGGLE in his next review round: the pressed state mirrors the
  // pane's visibility and the click inverts it. Its gate is the same one the
  // Call button uses — a non-null agentPubkey — and that gate is the thing
  // worth pinning: a human DM must not grow a toggle that would open a pane
  // with nothing to show.
  const toggles = [];
  const agentDm = await mount(
    props({
      panes: {
        thinkingVisible: true,
        toggleThinking: () => toggles.push(true),
        threadsVisible: false,
        threadsAvailable: false,
        toggleThreads: () => {},
      },
    }),
  );
  const toggle = agentDm.container.querySelector(
    '[data-testid="toggle-thinking-panel"]',
  );
  assert.ok(toggle, "an agent DM renders the thinking toggle");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(
    toggle.getAttribute("aria-label"),
    "Hide thinking panel",
    "the label names the action the click will take",
  );
  await act(async () => {
    toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(toggles, [true], "clicking it toggles the thinking pane");
  await agentDm.unmount();

  const hidden = await mount(props());
  const hiddenToggle = hidden.container.querySelector(
    '[data-testid="toggle-thinking-panel"]',
  );
  assert.equal(hiddenToggle.getAttribute("aria-pressed"), "false");
  await hidden.unmount();

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

test("the replies toggle sits after the brain and is disabled with no thread", async () => {
  const calls = [];
  const mounted = await mount(
    props({
      panes: {
        thinkingVisible: false,
        toggleThinking: () => {},
        threadsVisible: false,
        threadsAvailable: false,
        toggleThreads: () => calls.push(true),
      },
    }),
  );
  const bar = mounted.container.querySelector(
    '[data-testid="channel-actions-bar"]',
  );
  const ids = [...bar.querySelectorAll("button")]
    .map((button) => button.getAttribute("data-testid"))
    .filter(Boolean);
  // "immediately right of the brain icon" (Sam, 2026-09-22) — pinned as an
  // order so a future insertion cannot silently move it.
  assert.ok(ids.indexOf("toggle-thinking-panel") !== -1);
  assert.equal(
    ids.indexOf("toggle-threads-panel"),
    ids.indexOf("toggle-thinking-panel") + 1,
    "the replies toggle renders immediately right of the brain",
  );
  const replies = bar.querySelector('[data-testid="toggle-threads-panel"]');
  assert.equal(replies.disabled, true, "no thread to show yet");
  await act(async () => {
    replies.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  assert.deepEqual(calls, [], "a disabled replies toggle fires nothing");
  await mounted.unmount();

  const live = await mount(
    props({
      panes: {
        thinkingVisible: false,
        toggleThinking: () => {},
        threadsVisible: true,
        threadsAvailable: true,
        toggleThreads: () => calls.push(true),
      },
    }),
  );
  const liveButton = live.container.querySelector(
    '[data-testid="toggle-threads-panel"]',
  );
  assert.equal(liveButton.disabled, false);
  assert.equal(liveButton.getAttribute("aria-pressed"), "true");
  await act(async () => {
    liveButton.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  assert.deepEqual(calls, [true]);
  await live.unmount();
});

test("the dictation mic renders when supported, toggles, and shows interim text", async () => {
  const bare = await mount(props());
  assert.equal(
    bare.container.querySelector('[data-testid="composer-dictation"]'),
    null,
    "no dictation controller, no button",
  );
  await bare.unmount();

  const unsupported = await mount(
    props({ dictation: dictationController({ supported: false }) }),
  );
  assert.equal(
    unsupported.container.querySelector('[data-testid="composer-dictation"]'),
    null,
    "an unsupported browser renders no button",
  );
  await unsupported.unmount();

  const idle = dictationController();
  const listening = await mount(props({ dictation: idle }));
  const mic = listening.container.querySelector(
    '[data-testid="composer-dictation"]',
  );
  assert.ok(mic, "a supported controller renders the mic");
  assert.equal(mic.getAttribute("aria-pressed"), "false");
  assert.equal(
    listening.container.querySelector('[data-testid="dictation-interim"]'),
    null,
    "no interim line while idle",
  );
  await act(async () => {
    mic.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(idle.toggles, 1, "the click reaches the controller");
  await listening.unmount();

  const active = await mount(
    props({
      dictation: dictationController({
        active: true,
        interimText: "hello wor",
      }),
    }),
  );
  const activeMic = active.container.querySelector(
    '[data-testid="composer-dictation"]',
  );
  assert.equal(activeMic.getAttribute("aria-pressed"), "true");
  assert.equal(activeMic.getAttribute("aria-label"), "Stop dictation");
  const interim = active.container.querySelector(
    '[data-testid="dictation-interim"]',
  );
  assert.ok(interim, "a live transcript line shows while listening");
  assert.equal(interim.textContent, "hello wor");
  await active.unmount();

  const failed = await mount(
    props({
      dictation: dictationController({
        error: "Speech recognition connection closed.",
      }),
    }),
  );
  const errorLine = failed.container.querySelector(
    '[data-testid="dictation-error"]',
  );
  assert.ok(errorLine, "a bridge failure is said out loud, not swallowed");
  assert.equal(errorLine.getAttribute("role"), "alert");
  await failed.unmount();
});

test("the copy-channel-name action is gone", async () => {
  // Sam circled it for removal in the 2026-09-22 review; the pinned absence
  // is what stops a merge from quietly resurrecting it.
  const mounted = await mount(props());
  assert.equal(
    mounted.container.querySelector('[data-testid="copy-channel-name"]'),
    null,
  );
  await mounted.unmount();
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
