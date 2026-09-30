import assert from "node:assert/strict";
import { test, after } from "node:test";

// Huddle call transcript row, in the REAL MessageRow under jsdom + act
// (harness trimmed from AgentAvatarHoverCard.test.mjs).
//
// When a huddle ends the relay posts ONE relay-signed kind:9 into the parent
// channel tagged ["buzz-system","call-transcript"] (buzz-relay
// audio/transcript.rs). The relay key has no kind:0 profile, so the plain
// `authorLabel` would name the row after the relay's truncated hex pubkey.
// These tests pin the purpose label and that the transcript's one-line-per-
// speaker body survives markdown rendering (single "\n" is a soft break that
// collapses, so the relay separates lines with a blank line).
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
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
const FORCE_JSDOM = new Set([
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
  if (FORCE_JSDOM.has(key) || !(key in globalThis)) {
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
dom.window.matchMedia = (query) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

const OWNER = "0".repeat(64);
const RELAY = "7".repeat(64);
const IMPOSTOR = "9".repeat(64);

// The relay's NIP-11 document advertises RELAY as its `self` key — the only
// author whose `buzz-system` tag is honoured. Reads are counted so the spoof
// test can show the key was actually consulted.
const nip11Reads = [];
globalThis.fetch = async (url) => {
  nip11Reads.push(String(url));
  return new Response(JSON.stringify({ name: "test", self: RELAY }), {
    status: 200,
    headers: { "content-type": "application/nostr+json" },
  });
};

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return {
        session: { subscribe: () => () => {}, publish: async () => ({ ok: true }) },
        status: "open",
      };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  "@/shared/lib/useOwnPubkey": `
    export function useOwnPubkey() { return "${OWNER}"; }
  `,
  "@/features/custom-emoji/hooks": `
    export function useCustomEmoji() { return []; }
  `,
  "@/shared/ui/EmojiPicker": `
    export function EmojiPicker() { return null; }
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

/** The exact body shape buzz-relay's `render_transcript` produces. */
const TRANSCRIPT =
  "📞 Call transcript — Jared Dunn call\n\n" +
  "Sam: which drill should I buy?\n\n" +
  "Jared: The DeWalt 20V — best value.\n\n" +
  "Sam: thanks";

function relayEvent(tags, content = TRANSCRIPT, pubkey = RELAY) {
  return timelineMessageFromEvent({
    id: "c".repeat(64),
    pubkey,
    created_at: 1_000,
    kind: 9,
    content,
    tags: [["h", "chan"], ...tags],
    sig: "f".repeat(128),
  });
}

async function mountRow(message) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(MessageRow, {
          message,
          profiles: new Map(),
          grouped: false,
          replyCount: 0,
          active: false,
          reactionGroups: [],
          showActions: false,
          isAgent: false,
        }),
      ),
    );
  });
  // Let the (cached) NIP-11 read settle and the row re-render with it.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const triggers = container.querySelectorAll(
    `[data-testid="profile-trigger-${message.authorPubkey}"]`,
  );
  // Guard the harness: avatar + name triggers, the second one the name.
  assert.equal(triggers.length, 2);
  return {
    container,
    name: triggers[1].textContent,
    unmount: async () => {
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
}

test("a relay call transcript is labelled 'Call transcript', not the relay's hex", async () => {
  const row = await mountRow(relayEvent([["buzz-system", "call-transcript"]]));
  assert.equal(row.name, "Call transcript");
  assert.ok(
    !row.container.textContent.includes("77777777…"),
    "the truncated relay key must not appear anywhere in the row",
  );
  await row.unmount();
});

test("an unknown buzz-system value falls back to 'Buzz'", async () => {
  const row = await mountRow(relayEvent([["buzz-system", "future-thing"]]));
  assert.equal(row.name, "Buzz");
  await row.unmount();
});

test("control: the same relay key WITHOUT the tag keeps the ordinary label", async () => {
  // Proves the labels above come from the tag, not from something about the
  // author — an untagged relay message still names its (truncated) key.
  const row = await mountRow(relayEvent([], "hello"));
  assert.equal(row.name, "77777777…7777");
  await row.unmount();
});

test("a buzz-system tag from any author other than the relay is ignored", async () => {
  // A client forging the tag (relay ingest also rejects it) must not borrow
  // the relay's label: the row names its real author.
  const row = await mountRow(
    relayEvent([["buzz-system", "call-transcript"]], TRANSCRIPT, IMPOSTOR),
  );
  assert.equal(row.name, "99999999…9999");
  assert.ok(nip11Reads.length > 0, "the relay key was actually consulted");
  await row.unmount();
});

test("the transcript body keeps one speaker per line", async () => {
  const row = await mountRow(relayEvent([["buzz-system", "call-transcript"]]));
  const paragraphs = Array.from(
    row.container.querySelectorAll(".message-prose p"),
    (p) => p.textContent,
  );
  assert.deepEqual(paragraphs, [
    "📞 Call transcript — Jared Dunn call",
    "Sam: which drill should I buy?",
    "Jared: The DeWalt 20V — best value.",
    "Sam: thanks",
  ]);
  await row.unmount();
});
