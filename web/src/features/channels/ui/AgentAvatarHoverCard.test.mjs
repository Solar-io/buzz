import assert from "node:assert/strict";
import { test, after, mock } from "node:test";

// Agent avatar hover card under jsdom + act (harness from ThreadPanel.test.mjs).
// Owner ask: the config card shows on an agent's AVATAR only — never its name.
// The REAL MessageRow, UserProfilePopover and hover card are mounted; the
// relay session is a recording fake so the per-row subscription cost is
// observable, and `useOwnPubkey` is pinned to the owner.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos/",
  pretendToBeVisual: true,
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  resizeObserver: globalThis.ResizeObserver,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
};
const globalKeysBefore = new Set(Object.getOwnPropertyNames(globalThis));
const FORCE_JSOM = new Set([
  "Event",
  "EventTarget",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "getComputedStyle",
]);
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "globalThis") {
    continue;
  }
  if (FORCE_JSOM.has(key) || !(key in globalThis)) {
    try {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => dom.window[key],
      });
    } catch {
      // A non-configurable Node global we must not (and need not) shadow.
    }
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const SilentResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.ResizeObserver = SilentResizeObserver;
dom.window.ResizeObserver = SilentResizeObserver;

// `(any-hover: hover)` is switchable per test.
let anyHover = true;
dom.window.matchMedia = (query) => ({
  matches: query === "(any-hover: hover)" ? anyHover : false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

const OWNER = "0".repeat(64);
const AGENT = "a".repeat(64);

// Recording relay session: every subscribe is logged; the agent's 30177 is
// answered so the card has real rows to render.
const subscribeCalls = [];
function agentEvent() {
  return {
    id: "e".repeat(64),
    pubkey: OWNER,
    kind: 30177,
    created_at: 1_000,
    tags: [["d", AGENT]],
    content: JSON.stringify({
      name: "Evie",
      model: "claude-opus-5-5",
      provider: "anthropic",
      parallelism: 1,
      respond_to: "owner-only",
      effort: { acp: "medium", text_turn: "low" },
    }),
    sig: "f".repeat(128),
  };
}
globalThis.__BUZZ_TEST_RELAY_SESSION__ = {
  subscribe(filters, options) {
    subscribeCalls.push(filters);
    const list = Array.isArray(filters) ? filters : [filters];
    queueMicrotask(() => {
      if (
        list.some((f) => f.kinds?.includes(30177) && f["#d"]?.includes(AGENT))
      ) {
        options.onEvent(agentEvent());
      }
      if (
        list.some((f) => f.kinds?.includes(30183) && f["#d"]?.includes(AGENT))
      ) {
        // The owner's voice assignment for this agent (kind 30183).
        options.onEvent({
          id: "d".repeat(64),
          pubkey: OWNER,
          kind: 30183,
          created_at: 1_000,
          tags: [["d", AGENT]],
          content: JSON.stringify({
            version: 1,
            engine: "chatterbox",
            key: "chatterbox:evie",
            label: "Evie",
          }),
          sig: "f".repeat(128),
        });
      }
      options.onEose?.();
    });
    return () => {};
  },
  publish: async () => ({ ok: true }),
};

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_RELAY_SESSION__ ?? null, status: "open" };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  "@/shared/lib/useOwnPubkey": `
    export function useOwnPubkey() {
      return "${OWNER}";
    }
  `,
  "@/features/custom-emoji/hooks": `
    export function useCustomEmoji() {
      return [];
    }
  `,
  "@/shared/ui/EmojiPicker": `
    export function EmojiPicker() {
      return null;
    }
  `,
  sonner: `
    export const toast = { error() {}, message() {}, success() {} };
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { timelineMessageFromEvent } = await import("../lib/messageBuffer.ts");
const { TooltipProvider } = await import("@/shared/ui/tooltip");
const { MessageRow } = await import("./MessageRow.tsx");

after(() => {
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (!globalKeysBefore.has(key)) {
      delete globalThis[key];
    }
  }
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.ResizeObserver = originals.resizeObserver;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  dom.window.close();
});

function message() {
  return timelineMessageFromEvent({
    id: "m".repeat(64),
    pubkey: AGENT,
    created_at: 1_000,
    kind: 9,
    content: "hello",
    tags: [["h", "chan"]],
    sig: "f".repeat(128),
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountRow({ isAgent = true } = {}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(MessageRow, {
          message: message(),
          profiles: new Map(),
          grouped: false,
          replyCount: 0,
          active: false,
          reactionGroups: [],
          showActions: false,
          isAgent,
        }),
      ),
    );
  });
  await flush();
  const triggers = container.querySelectorAll(
    `[data-testid="profile-trigger-${AGENT}"]`,
  );
  // Guard the harness: exactly two triggers, the second one the name.
  assert.equal(triggers.length, 2);
  assert.ok(triggers[1].textContent.length > 2, "second trigger is the name");
  return {
    container,
    // First trigger is the avatar, second the author name.
    avatar: triggers[0],
    name: triggers[1],
    unmount: async () => {
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
}

function pointer(type, target, pointerType, relatedTarget = null) {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    relatedTarget,
  });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return act(async () => {
    target.dispatchEvent(event);
  });
}

const hoverEnter = (target, pointerType = "mouse") =>
  pointer("pointerover", target, pointerType, null);
const hoverLeave = (target) =>
  pointer("pointerout", target, "mouse", dom.window.document.body);

function card() {
  return dom.window.document.querySelector('[data-testid="agent-config-card"]');
}
function section() {
  return dom.window.document.querySelector(
    '[data-testid="agent-config-section"]',
  );
}

async function advance(ms) {
  await act(async () => {
    mock.timers.tick(ms);
  });
  await flush();
}

async function click(target) {
  await act(async () => {
    target.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

test("avatar hover: closed at 499 ms, open with rows at 500 ms, leave closes", async () => {
  anyHover = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  const row = await mountRow();
  try {
    await hoverEnter(row.avatar);
    await flush();
    await advance(499);
    assert.ok(card() === null, "must not open before the 500 ms dwell");
    await advance(1);
    const open = card();
    assert.ok(open, "card opens at 500 ms");
    assert.match(open.textContent, /claude-opus-5-5/);
    assert.match(open.textContent, /medium/);
    assert.match(open.textContent, /Text-turn effort/);
    // AC-W5: the effective voice with its source, owner row winning.
    const voiceRow = open.querySelector(
      '[data-testid="agent-config-row-voice"]',
    );
    assert.ok(voiceRow, "the Voice row renders");
    assert.match(voiceRow.textContent, /Evie \(Chatterbox\) · set by owner/);
    assert.ok(
      open.querySelector('[data-testid="agent-config-change-voice"]') === null,
      "the hover card stays read-only",
    );
    await hoverLeave(row.avatar);
    await flush();
    assert.ok(card() === null, "pointerleave closes the card");
  } finally {
    await row.unmount();
    mock.timers.reset();
  }
});

test("no subscriptions before the avatar is hovered (per-row cost)", async () => {
  anyHover = true;
  subscribeCalls.length = 0;
  const row = await mountRow();
  try {
    const configKinds = (f) =>
      [30177, 30175, 30182, 30183].some((k) => f.kinds?.includes(k));
    assert.equal(subscribeCalls.flat().filter(configKinds).length, 0);
    await hoverEnter(row.avatar);
    await flush();
    assert.ok(
      subscribeCalls.flat().some((f) => f.kinds?.includes(30177)),
      "arming opens the 30177 read",
    );
  } finally {
    await row.unmount();
  }
});

test("touch pointer never opens the hover card", async () => {
  anyHover = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  const row = await mountRow();
  try {
    await hoverEnter(row.avatar, "touch");
    await advance(1_000);
    assert.ok(card() === null);
  } finally {
    await row.unmount();
    mock.timers.reset();
  }
});

test("hovering the NAME never renders the agent config card", async () => {
  anyHover = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  const row = await mountRow();
  try {
    await hoverEnter(row.name);
    await advance(1_000);
    assert.ok(card() === null);
  } finally {
    await row.unmount();
    mock.timers.reset();
  }
});

test("a non-agent author gets no hover card", async () => {
  anyHover = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  const row = await mountRow({ isAgent: false });
  try {
    // Compare as booleans: a failing equal() on a jsdom node deep-inspects
    // the whole document and never finishes.
    assert.ok(
      row.container.querySelector(
        `[data-testid="agent-avatar-hover-${AGENT}"]`,
      ) === null,
    );
    await hoverEnter(row.avatar);
    await advance(1_000);
    assert.ok(card() === null);
  } finally {
    await row.unmount();
    mock.timers.reset();
  }
});

test("clicking the avatar shows the agent section; clicking the name does not", async () => {
  anyHover = false; // touch-only device: the tap path
  const row = await mountRow();
  try {
    await click(row.avatar);
    assert.ok(
      dom.window.document.querySelector('[data-testid="user-profile-popover"]'),
      "avatar click opens the profile card",
    );
    assert.ok(section(), "avatar profile card carries the agent section");
    assert.match(section().textContent, /claude-opus-5-5/);
    assert.ok(
      section().querySelector('[data-testid="agent-config-change-voice"]'),
      "the OWNER's profile card offers Change voice…",
    );
  } finally {
    await row.unmount();
  }
  const fresh = await mountRow();
  try {
    await click(fresh.name);
    assert.ok(
      dom.window.document.querySelector('[data-testid="user-profile-popover"]'),
      "name click opens the profile card",
    );
    assert.ok(section() === null, "name profile card has no agent section");
  } finally {
    await fresh.unmount();
  }
});
