import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WIRING: a Stage open event reaches the REAL timeline host (ChannelTimeline
 * -> MessageRow -> StageOpenCard) and renders the card; a malformed open tag
 * degrades to the plain fallback content; a part row carries its chip; and
 * the card's buttons call the registered launcher (unlock INSIDE the click,
 * then open) with the right mode. Same harness and the same single
 * virtualizer stub as `channels/ui/cardAnswerWiring.test.mjs` (read its
 * header for why the pass-through VList is not the thing under test).
 *
 * Stage media is stubbed at its own door (`stage/lib/stageMedia`) so the
 * cover preload is observable: the card must fetch exactly palette[0].
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
  pretendToBeVisual: true,
});
/**
 * Same forced list, and the same reason, as `DecisionCard.test.mjs`: node has
 * its own `Event`/`CustomEvent` classes and an event built from those cannot
 * be dispatched on a jsdom node.
 */
const FORCE_JSDOM = new Set([
  "CustomEvent",
  "Event",
  "EventTarget",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "PointerEvent",
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
      // A non-configurable node global we must not (and need not) shadow.
    }
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.matchMedia ??= () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
globalThis.matchMedia = dom.window.matchMedia;
const SilentResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.ResizeObserver = SilentResizeObserver;
dom.window.ResizeObserver = SilentResizeObserver;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_IDB__ = { data: new Map() };

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  // A session OBJECT, not null: custom-emoji/hooks.ts keys a WeakMap on
  // the session whenever status is "open", and a null key throws
  // "Invalid value used as weak map key" out of a passive effect.
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return {
        session: (globalThis.__BUZZ_TEST_RELAY_SESSION__ ??= {
          subscribe: () => () => {},
          publish: async () => ({ ok: true, message: "" }),
        }),
        status: "open",
      };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  "@/shared/theme/ThemeProvider": `
    export function useTheme() { return { isDark: true }; }
    export function ThemeProvider({ children }) { return children ?? null; }
  `,
  "idb-keyval": `
    const store = globalThis.__BUZZ_TEST_IDB__;
    export async function get(key) { return store.data.get(key); }
    export async function set(key, value) { store.data.set(key, value); }
    export async function del(key) { store.data.delete(key); }
    export async function keys() { return Array.from(store.data.keys()); }
    export async function delMany(list) { for (const k of list) store.data.delete(k); }
  `,
  // The pass-through virtualizer. The handle carries every method the
  // timeline's effects call, so nothing here changes which rows mount — the
  // list simply renders all of them.
  //
  // React comes off a global rather than an `import`: a stub module's URL is
  // `buzz-web-test-stub:virtua`, and node cannot resolve a BARE specifier
  // against a non-file base (`ERR_INVALID_URL: input './package.json'`).
  virtua: `
    const { createElement, forwardRef, useImperativeHandle } =
      globalThis.__BUZZ_TEST_REACT__;
    export const VList = forwardRef(function VList(props, ref) {
      useImperativeHandle(ref, () => ({
        scrollToIndex() {},
        scrollTo() {},
        scrollBy() {},
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        getItemSize: () => 0,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
      }));
      return createElement(
        "div",
        { className: props.className, onScroll: props.onScroll },
        props.children,
      );
    });
  `,
  "@/features/stage/lib/stageMedia": `
    export async function fetchStageMedia(url) {
      (globalThis.__STAGE_MEDIA_CALLS__ ??= []).push(url);
      return "blob:" + url;
    }
    export async function decodeStageImage() {}
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { timelineMessageFromEvent } = await import(
  "@/features/channels/lib/messageBuffer.ts"
);
const { TooltipProvider } = await import("@/shared/ui/tooltip");
const { ChannelTimeline } = await import(
  "@/features/channels/ui/ChannelTimeline.tsx"
);
const { buildStageTag } = await import("../lib/stageTag.ts");
const { setStageLauncher } = await import("../lib/stageLauncher.ts");

const ME = "1".repeat(64);
const AGENT = "2".repeat(64);
const CHANNEL = "ch-stage";
const hex = (n) => n.toString(16).padStart(64, "0");
const COVER = `https://relay.test/media/${hex(0)}.png`;

function openEvent(id, tagValue, createdAt = 100) {
  return {
    id,
    pubkey: AGENT,
    kind: 9,
    created_at: createdAt,
    content:
      "🎬 Stage: Kyoto recap — 3 frames. Open in the Buzz web app to watch.",
    tags: [["h", CHANNEL], tagValue],
    sig: "0".repeat(128),
  };
}

const VALID_OPEN = buildStageTag({
  v: 1,
  op: "open",
  title: "Kyoto recap",
  voice: false,
  parts: [0, 1, 2].map((n) => ({
    x: hex(n),
    url: `https://relay.test/media/${hex(n)}.png`,
    m: "image/png",
  })),
});

function partEvent(id, openId, i, createdAt) {
  const url = `https://relay.test/media/${hex(i)}.png`;
  return {
    id,
    pubkey: AGENT,
    kind: 9,
    created_at: createdAt,
    content: `Frame words ${i}.\n![image](${url})`,
    tags: [
      ["h", CHANNEL],
      ["imeta", `url ${url}`, "m image/png"],
      buildStageTag({ v: 1, op: "part", s: openId, i, hold: true }),
    ],
    sig: "0".repeat(128),
  };
}

async function mount(events) {
  const messages = events.map((event) => {
    const message = timelineMessageFromEvent(event);
    assert.ok(message, `event ${event.id} must parse`);
    return message;
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChannelTimeline, {
          messages,
          profiles: new Map(),
          replyCounts: new Map(),
          selfPubkey: ME,
          showActions: false,
        }),
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    row: (id) => container.querySelector(`[data-testid="message-row-${id}"]`),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const OPEN_ID = hex(0xabc);

test("a valid open tag renders the Stage card in the real timeline", async () => {
  globalThis.__STAGE_MEDIA_CALLS__ = [];
  const view = await mount([openEvent(OPEN_ID, VALID_OPEN)]);
  const row = view.row(OPEN_ID);
  assert.ok(row, "the open row mounts (harness renders real rows)");
  const cards = view.container.querySelectorAll(
    '[data-testid="stage-open-card"]',
  );
  assert.equal(cards.length, 1);
  assert.equal(
    row.querySelector('[data-testid="stage-open-card-title"]').textContent,
    "Kyoto recap",
  );
  assert.equal(
    row.querySelector('[data-testid="stage-open-card-count"]').textContent,
    "3 frames",
  );
  assert.equal(
    row.textContent.includes("Open in the Buzz web app"),
    false,
    "the fallback content is replaced by the card",
  );
  assert.deepEqual(
    globalThis.__STAGE_MEDIA_CALLS__,
    [COVER],
    "only the cover (palette[0]) is preloaded from the timeline",
  );
  const cover = row.querySelector("img");
  assert.ok(cover, "the cover renders from the fetched object URL");
  assert.equal(cover.getAttribute("src"), `blob:${COVER}`);
  await view.unmount();
});

test("a malformed open tag renders the plain fallback, never a card", async () => {
  const broken = ["stage", '{"v":1,"op":"open","title":"x","parts":[]}'];
  const view = await mount([openEvent(OPEN_ID, broken)]);
  const row = view.row(OPEN_ID);
  assert.ok(row, "the row still renders");
  assert.equal(
    view.container.querySelectorAll('[data-testid="stage-open-card"]').length,
    0,
  );
  assert.ok(row.textContent.includes("Open in the Buzz web app to watch"));
  await view.unmount();
});

test("an unparsed stage shape (old timeline cache) falls back, no crash", async () => {
  const event = openEvent(OPEN_ID, VALID_OPEN);
  const message = timelineMessageFromEvent(event);
  // A cached row whose `stage` never went through the parser.
  message.stage = { v: 1, op: "open", title: "cached", parts: [] };
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChannelTimeline, {
          messages: [message],
          profiles: new Map(),
          replyCounts: new Map(),
          selfPubkey: ME,
          showActions: false,
        }),
      ),
    );
  });
  const row = container.querySelector(`[data-testid="message-row-${OPEN_ID}"]`);
  assert.ok(row, "the row renders");
  assert.equal(row.querySelector('[data-testid="stage-open-card"]'), null);
  assert.ok(row.textContent.includes("Open in the Buzz web app to watch"));
  await act(async () => root.unmount());
  container.remove();
});

test("a part row stays an ordinary message and carries its chip", async () => {
  const partId = hex(0xdef);
  const view = await mount([
    openEvent(OPEN_ID, VALID_OPEN),
    partEvent(partId, OPEN_ID, 1, 101),
  ]);
  const row = view.row(partId);
  assert.ok(row);
  assert.ok(row.textContent.includes("Frame words 1."));
  const chip = row.querySelector('[data-testid="stage-part-chip"]');
  assert.ok(chip, "the part chip renders");
  assert.ok(chip.textContent.includes("frame 2"));
  assert.equal(
    view.row(OPEN_ID).querySelector('[data-testid="stage-part-chip"]'),
    null,
    "the open row has no part chip",
  );
  await view.unmount();
});

test("Open Stage / Replay unlock inside the click, then open with the mode", async () => {
  const calls = [];
  const unregister = setStageLauncher({
    unlock: () => calls.push(["unlock"]),
    open: (openId, channelId, mode) =>
      calls.push(["open", openId, channelId, mode]),
  });
  const view = await mount([openEvent(OPEN_ID, VALID_OPEN)]);
  const row = view.row(OPEN_ID);
  await act(async () => {
    row.querySelector('[data-testid="stage-open-button"]').click();
  });
  await act(async () => {
    row.querySelector('[data-testid="stage-replay-button"]').click();
  });
  assert.deepEqual(calls, [
    ["unlock"],
    ["open", OPEN_ID, CHANNEL, "live"],
    ["unlock"],
    ["open", OPEN_ID, CHANNEL, "replay"],
  ]);
  unregister();
  await view.unmount();
});
