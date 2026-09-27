import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * StageView / StageRoute banner — the REAL overlay, mounted in jsdom with a
 * fake speech player (speak = deferred the test settles), a fake relay
 * session (history query answers from a fixture) and Stage media stubbed at
 * its own door. Same harness as `channels/ui/cardAnswerWiring.test.mjs`.
 *
 * Covers design §15.4 UI deltas: portrait stacked vs landscape split, the
 * hold:false showing appearing immediately while speech is pending, chat rows
 * of unreleased showings hidden, voice:false pacing on arrival, persisted
 * mute + M key, cold "Tap to start" unlocking audio inside the tap, and the
 * "Stage ready" banner for a live open from someone else.
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
          subscribe: (filters, options) => {
            const answer = globalThis.__STAGE_HISTORY__ ?? [];
            queueMicrotask(() => {
              const f = Array.isArray(filters) ? filters[0] : filters;
              for (const event of answer) {
                if (f.ids && !f.ids.includes(event.id)) continue;
                if (f.authors && !f.authors.includes(event.pubkey)) continue;
                options.onEvent(event);
              }
              options.onEose?.();
            });
            return () => {};
          },
          publish: async () => ({ ok: true, message: "" }),
        }),
        status: "open",
      };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  "@/shared/theme/ThemeProvider": `
    export const THEME_STORAGE_KEY = "buzz-theme";
    export const FOLLOW_SYSTEM_STORAGE_KEY = "buzz-follow-system";
    export const ACCENT_STORAGE_KEY = "buzz-accent-color";
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
    export async function fetchStageMedia(url) { return "blob:" + url; }
    export async function decodeStageImage() {}
  `,
};

let splitMatches = true;
dom.window.matchMedia = (query) => ({
  matches: query.includes("orientation: landscape") ? splitMatches : false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
globalThis.matchMedia = dom.window.matchMedia;

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { timelineMessageFromEvent } = await import(
  "@/features/channels/lib/messageBuffer.ts"
);
const { TooltipProvider } = await import("@/shared/ui/tooltip");
const { buildStageTag } = await import("../lib/stageTag.ts");
const { StageView } = await import("./StageView.tsx");
const { useStageReadyBanner } = await import("./StageRoute.tsx");
const { STAGE_MUTED_KEY } = await import("../useStage.ts");

const ME = "1".repeat(64);
const AGENT = "2".repeat(64);
const CHANNEL = "ch-stage";
const hex = (n) => n.toString(16).padStart(64, "0");
const OPEN_ID = hex(0xa0);
const T0 = 1_800_000_000;

function openEvent({
  voice = true,
  id = OPEN_ID,
  pubkey = AGENT,
  at = T0,
} = {}) {
  return {
    id,
    pubkey,
    kind: 9,
    created_at: at,
    content: "🎬 Stage",
    tags: [
      ["h", CHANNEL],
      buildStageTag({
        v: 1,
        op: "open",
        title: "Deck",
        voice,
        parts: [0, 1, 2].map((n) => ({
          x: hex(n),
          url: `https://relay.test/media/${hex(n)}.png`,
          m: "image/png",
        })),
      }),
    ],
    sig: "0".repeat(128),
  };
}

function partEvent(n, i, { hold = true } = {}) {
  const url = `https://relay.test/media/${hex(i)}.png`;
  return {
    id: hex(0xb00 + n),
    pubkey: AGENT,
    kind: 9,
    created_at: T0 + n,
    content: `Words ${n}.\n![image](${url})`,
    tags: [
      ["h", CHANNEL],
      ["imeta", `url ${url}`, "m image/png"],
      buildStageTag({ v: 1, op: "part", s: OPEN_ID, i, hold }),
    ],
    sig: "0".repeat(128),
  };
}

const toMessages = (events) => events.map((e) => timelineMessageFromEvent(e));

function fakePlayer() {
  const calls = { speak: [], interrupt: 0, unlock: 0, muted: [] };
  const pending = [];
  return {
    calls,
    finishAll: () => {
      for (const done of pending.splice(0)) done("spoken");
    },
    speak(text) {
      calls.speak.push(text);
      return new Promise((resolve) => pending.push(resolve));
    },
    interrupt() {
      calls.interrupt += 1;
      for (const done of pending.splice(0)) done("stopped");
    },
    setMuted(m) {
      calls.muted.push(m);
    },
    setOutputDevice() {},
    unlock() {
      calls.unlock += 1;
    },
    dispose() {},
    contextState: () => "running",
    onContextStateChange: () => () => {},
  };
}

async function flush() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      for (let n = 0; n < 20; n += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount({
  messages,
  player,
  gestured = true,
  entryMode = "live",
}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    openId: OPEN_ID,
    channelId: CHANNEL,
    messages,
    members: [],
    profiles: new Map(),
    send: async () => ({ ok: true, message: "" }),
    selfPubkey: ME,
    player,
    entryMode,
    gestured,
    huddleSpeech: null,
    onChannel: () => {},
    onExit: () => {},
  };
  const render = async (next) => {
    Object.assign(props, next);
    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(StageView, { ...props }),
        ),
      );
    });
    await flush();
  };
  await render({});
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  return {
    container,
    q,
    render,
    showing: () =>
      (q("stage-image") ?? q("stage-image-loading"))?.getAttribute(
        "data-showing",
      ) ?? null,
    chatHas: (id) =>
      q("stage-chat-list")?.querySelector(
        `[data-testid="message-row-${id}"]`,
      ) !== null,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("landscape >= 1024: chat 1/3 left, image 2/3 right", async () => {
  splitMatches = true;
  globalThis.__STAGE_HISTORY__ = [openEvent({ voice: false }), partEvent(1, 0)];
  const view = await mount({ messages: [], player: fakePlayer() });
  const stage = view.q("stage-view");
  assert.ok(stage, "the overlay mounts");
  assert.equal(stage.getAttribute("data-layout"), "split");
  const grid = stage.firstElementChild;
  assert.match(grid.className, /grid-cols-\[minmax\(0,1fr\)_minmax\(0,2fr\)\]/);
  assert.equal(grid.children[0].getAttribute("data-testid"), "stage-chat-pane");
  assert.equal(
    grid.children[1].getAttribute("data-testid"),
    "stage-image-pane",
  );
  assert.ok(
    view.q("stage-chat-pane").querySelector("textarea"),
    "composer in chat pane",
  );
  await view.unmount();
});

test("portrait: stacked, image (2/3) above chat (1/3)", async () => {
  splitMatches = false;
  globalThis.__STAGE_HISTORY__ = [openEvent({ voice: false }), partEvent(1, 0)];
  const view = await mount({ messages: [], player: fakePlayer() });
  const stage = view.q("stage-view");
  assert.equal(stage.getAttribute("data-layout"), "stacked");
  const grid = stage.firstElementChild;
  assert.match(grid.className, /grid-rows-\[minmax\(0,2fr\)_minmax\(0,1fr\)\]/);
  assert.equal(
    grid.children[0].getAttribute("data-testid"),
    "stage-image-pane",
  );
  assert.equal(grid.children[1].getAttribute("data-testid"), "stage-chat-pane");
  splitMatches = true;
  await view.unmount();
});

test("cold link shows Tap to start; the tap unlocks audio, then stages", async () => {
  globalThis.__STAGE_HISTORY__ = [openEvent({ voice: false }), partEvent(1, 0)];
  const player = fakePlayer();
  const view = await mount({ messages: [], player, gestured: false });
  const start = view.q("stage-tap-to-start");
  assert.ok(start);
  assert.equal(
    view.q("stage-image-pane"),
    null,
    "nothing staged before the tap",
  );
  assert.equal(player.calls.unlock, 0);
  await act(async () => start.click());
  await flush();
  assert.equal(player.calls.unlock, 1, "unlock ran inside the tap");
  assert.equal(
    view.showing(),
    partEvent(1, 0).id,
    "late join lands on the newest showing",
  );
  await view.unmount();
});

test("voice:false: a live held part is staged on arrival", async () => {
  const open = openEvent({ voice: false });
  globalThis.__STAGE_HISTORY__ = [open, partEvent(1, 0)];
  const player = fakePlayer();
  const view = await mount({ messages: [], player });
  assert.equal(view.showing(), partEvent(1, 0).id);
  await view.render({
    messages: toMessages([open, partEvent(1, 0), partEvent(2, 1)]),
  });
  assert.equal(view.showing(), partEvent(2, 1).id, "shown with no speech gate");
  assert.equal(player.calls.speak.length, 0, "voice:false never speaks");
  await view.unmount();
});

test("hold:false shows immediately while speech pends; held rows stay hidden until released", async () => {
  const open = openEvent({ voice: true });
  globalThis.__STAGE_HISTORY__ = [open];
  const player = fakePlayer();
  const view = await mount({ messages: toMessages([open]), player });
  const p1 = partEvent(1, 0);
  const p2 = partEvent(2, 1);
  const p3 = partEvent(3, 2, { hold: false });
  await view.render({ messages: toMessages([open, p1]) });
  assert.equal(view.showing(), p1.id);
  assert.deepEqual(player.calls.speak, ["Words 1."]);
  await view.render({ messages: toMessages([open, p1, p2]) });
  assert.equal(view.showing(), p1.id, "held p2 waits for p1's speech");
  assert.equal(
    view.chatHas(p2.id),
    false,
    "an unreleased showing's chat row is hidden",
  );
  assert.equal(view.chatHas(p1.id), true);
  await view.render({ messages: toMessages([open, p1, p2, p3]) });
  assert.equal(view.showing(), p3.id, "hold:false is staged on arrival");
  assert.equal(player.calls.interrupt, 1, "it interrupts the pending speech");
  assert.equal(
    view.chatHas(p2.id),
    true,
    "earlier held showing released silently",
  );
  assert.deepEqual(
    player.calls.speak,
    ["Words 1.", "Words 3."],
    "p2 never spoken",
  );
  await view.unmount();
});

test("M toggles mute: persisted, player gain muted, aria-pressed", async () => {
  dom.window.localStorage.removeItem(STAGE_MUTED_KEY);
  globalThis.__STAGE_HISTORY__ = [openEvent({ voice: true })];
  const player = fakePlayer();
  const view = await mount({ messages: [], player });
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "m" }),
    );
  });
  assert.equal(dom.window.localStorage.getItem(STAGE_MUTED_KEY), "1");
  assert.equal(player.calls.muted.at(-1), true);
  assert.equal(view.q("stage-mute").getAttribute("aria-pressed"), "true");
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "M" }),
    );
  });
  assert.equal(dom.window.localStorage.getItem(STAGE_MUTED_KEY), "0");
  await view.unmount();
});

function BannerProbe({ messages, selfPubkey, out }) {
  const { banner } = useStageReadyBanner(CHANNEL, messages, selfPubkey, null);
  out.banner = banner;
  return null;
}

test("banner: a live open from someone else raises 'Stage ready'; history and self do not", async () => {
  const out = {};
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  const renderProbe = async (events, self = ME) => {
    await act(async () => {
      root.render(
        React.createElement(BannerProbe, {
          messages: toMessages(events),
          selfPubkey: self,
          out,
        }),
      );
    });
  };
  const old = openEvent({ id: hex(0xc1) });
  await renderProbe([old]);
  assert.equal(out.banner, null, "an open already in history is not a banner");
  const mine = openEvent({ id: hex(0xc2), pubkey: ME, at: T0 + 5 });
  await renderProbe([old, mine]);
  assert.equal(out.banner, null, "my own open is not a banner");
  const fresh = openEvent({ id: hex(0xc3), at: T0 + 9 });
  await renderProbe([old, mine, fresh]);
  assert.deepEqual(out.banner, { openId: fresh.id, title: "Deck" });
  await act(async () => root.unmount());
});
