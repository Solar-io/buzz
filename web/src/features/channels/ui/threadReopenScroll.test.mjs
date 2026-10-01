import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Re-opening a folded inline thread in the REAL ChannelTimeline must leave the
 * thread where the reader clicked — never yanked off screen by the tail.
 *
 * Filed bug 706x8b4zrjdn (2026-10-01): "re-opening a folded inline thread
 * sometimes scrolls it off screen" (~15% of runs). Two defects, both pinned
 * here deterministically (no wall-clock races):
 *
 * 1. RESUME: opening a thread above the newest row paused follow-the-tail, but
 *    only scroll events in the next 600ms were ignored. The first scroll event
 *    after that window whose metrics read "at the bottom" — a late virtua
 *    re-measure, an image sizing in — RESUMED following on position alone,
 *    and the next geometry change pinned the list to the newest row, over the
 *    thread. Whether a stray scroll landed inside or outside the 600ms was the
 *    race. A thread the reader opened now stays held until the READER moves
 *    the list (or sends / switches view).
 * 2. ANCHOR: the open located the scroller as the wrapper's FIRST child —
 *    which is the pinned day pill whenever one is showing (the common case
 *    once scrolled), so the anchor hold queried the pill, found no row, and
 *    silently did nothing: the row grew upward under virtua's compensation.
 *
 * The one stub is `virtua` (jsdom has no layout — see permalinkJump.test.mjs):
 * the stand-in renders every child, records every scrollToIndex, and the
 * ResizeObserver is a fireable fake so a "geometry change" is an explicit step.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
  pretendToBeVisual: true,
});
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
dom.window.Element.prototype.scrollIntoView = () => {};
/** Every ResizeObserver the timeline mounts; `fireResize` triggers them all. */
const observers = [];
class FireableResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.live = true;
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.live = false;
  }
}
globalThis.ResizeObserver = FireableResizeObserver;
dom.window.ResizeObserver = FireableResizeObserver;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_IDB__ ??= { data: new Map() };

/** Every scrollToIndex: "tail:<key>" for align end, else the key. */
const jumps = [];
globalThis.__BUZZ_TEST_JUMPS__ = jumps;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
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
  virtua: `
    const React = globalThis.__BUZZ_TEST_REACT__;
    const { createElement, forwardRef, useImperativeHandle, useRef } = React;
    const ROW = 10;
    export const VList = forwardRef(function VList(props, ref) {
      const items = React.Children.toArray(props.children);
      const itemsRef = useRef(items);
      itemsRef.current = items;
      const offsetRef = useRef(0);
      const onScrollRef = useRef(props.onScroll);
      onScrollRef.current = props.onScroll;
      useImperativeHandle(ref, () => ({
        scrollToIndex(index, opts) {
          const item = itemsRef.current[index];
          const key = item ? String(item.key).replace(/^\\.\\$/, "") : "<none>";
          globalThis.__BUZZ_TEST_JUMPS__.push(
            opts?.align === "end" ? "tail:" + key : key,
          );
          offsetRef.current = Math.max(0, index * ROW - 90);
          // Real virtua reports the new offset; the pinned day pill keys on it.
          onScrollRef.current?.(offsetRef.current);
        },
        scrollTo() {},
        scrollBy() {},
        findItemIndex: (offset) => Math.floor(offset / ROW),
        getItemOffset: (index) => index * ROW,
        getItemSize: () => ROW,
        get scrollOffset() { return offsetRef.current; },
        get scrollSize() { return itemsRef.current.length * ROW; },
        viewportSize: 100,
      }));
      return createElement("div", { className: props.className }, items);
    });
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { timelineMessageFromEvent } = await import("../lib/messageBuffer.ts");
const { TooltipProvider } = await import("@/shared/ui/tooltip");
const { ChannelTimeline } = await import("./ChannelTimeline.tsx");

const AUTHOR = "2".repeat(64);
const CHANNEL = "ch-1";
const ROOT = "msg-root";

function event(id, minute, tags = []) {
  const parsed = timelineMessageFromEvent({
    id,
    pubkey: AUTHOR,
    kind: 9,
    created_at: 1_700_000_000 + minute * 60,
    content: `message ${id}`,
    tags: [["h", CHANNEL], ...tags],
    sig: "0".repeat(128),
  });
  assert.ok(parsed, `fixture ${id} must parse`);
  return parsed;
}

/**
 * A threaded row (3 replies) with fifteen newer rows under it — so the thread is
 * NOT on the newest row, the case where opening pauses the tail.
 */
const MESSAGES = [
  event(ROOT, 0),
  event("reply-1", 1, [["e", ROOT, "", "root"]]),
  event("reply-2", 2, [["e", ROOT, "", "root"]]),
  event("reply-3", 3, [["e", ROOT, "", "root"]]),
  ...Array.from({ length: 15 }, (_, i) => event(`msg-after-${i}`, 20 + i * 20)),
];

const LAST = MESSAGES[MESSAGES.length - 1].id;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parent that owns the fold/open choices, as useInlineThreads does. */
function Harness() {
  const [choices, setChoices] = useState(() => new Map());
  return React.createElement(
    TooltipProvider,
    null,
    React.createElement(ChannelTimeline, {
      messages: MESSAGES,
      profiles: new Map(),
      replyCounts: new Map(),
      showActions: false,
      tailKey: `${CHANNEL}:${MESSAGES[MESSAGES.length - 1].id}`,
      threads: {
        choices,
        focusId: null,
        revealId: null,
        onToggle: (rowId, open) =>
          setChoices((prev) => new Map(prev).set(rowId, open)),
        onReply: () => {},
        isDm: false,
        reply: {
          members: [],
          strictMentions: false,
          send: async () => ({ ok: true }),
        },
      },
    }),
  );
}

/** Unmount of the last view: a failed test must not leave its list live. */
let unmountLast = async () => {};

async function mount() {
  await unmountLast();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  const settle = async (ms) => {
    await act(async () => {
      await wait(ms);
    });
  };
  // Mount-time tail (double rAF + 250ms settle) and the first pinned-day pass.
  await settle(400);
  const scroller = container.querySelector(".buzz-timeline-scrollbar");
  assert.ok(scroller, "the list scroller renders");
  let mounted = true;
  unmountLast = async () => {
    if (mounted) {
      mounted = false;
      await act(async () => root.unmount());
      container.remove();
    }
  };
  return { container, scroller, settle, unmount: () => unmountLast() };
}

function chip(container) {
  const button = container.querySelector(`[data-testid="thread-chip-${ROOT}"]`);
  assert.ok(button, "the thread chip renders");
  return button;
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

/** Give the scroller real metrics and fire one native scroll event at it. */
function scrollEvent(scroller, scrollTop, scrollHeight = 1000) {
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: 100,
  });
  scroller.scrollTop = scrollTop;
  scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));
}

/** A geometry change (virtua measuring, media sizing) — the re-pin trigger. */
async function fireResize(settle) {
  for (const observer of observers) {
    if (observer.live) {
      observer.callback([]);
    }
  }
  await settle(50);
}

async function foldThenReopen(view) {
  assert.equal(
    chip(view.container).getAttribute("aria-expanded"),
    "true",
    "a thread with loaded replies starts open",
  );
  await click(chip(view.container));
  assert.equal(chip(view.container).getAttribute("aria-expanded"), "false");
  await view.settle(50);
  await click(chip(view.container));
  assert.equal(chip(view.container).getAttribute("aria-expanded"), "true");
}

test("harness: the stand-in list tails to the newest row and fires geometry re-pins", async () => {
  jumps.length = 0;
  const view = await mount();
  assert.ok(
    jumps.includes(`tail:${LAST}`),
    `the mount tails to the newest row (jumps: ${jumps.join(", ")})`,
  );
  const before = jumps.length;
  await fireResize(view.settle);
  assert.equal(
    jumps.length,
    before + 1,
    "while following, a geometry change re-pins the newest row",
  );
  await view.unmount();
});

test("re-opened thread: a late at-bottom scroll after the open does not resume the tail over it", async () => {
  jumps.length = 0;
  const view = await mount();
  await foldThenReopen(view);
  // Well past any settle window the open may arm (the old code's was 600ms):
  // the race this replaces was exactly WHEN this scroll arrived.
  await view.settle(700);
  const before = jumps.length;
  // virtua's late re-measure passes through the very bottom — no reader input.
  scrollEvent(view.scroller, 900);
  await fireResize(view.settle);
  assert.deepEqual(
    jumps.slice(before),
    [],
    "nothing may pin the list to the newest row over the thread the reader opened",
  );
  await view.unmount();
});

test("re-opened thread: the reader's own scroll back to the bottom resumes the tail", async () => {
  jumps.length = 0;
  const view = await mount();
  await foldThenReopen(view);
  await view.settle(700);
  scrollEvent(view.scroller, 500);
  // The reader wheels down to the very bottom: input, then the scroll it made.
  view.scroller.dispatchEvent(new dom.window.Event("wheel", { bubbles: true }));
  scrollEvent(view.scroller, 900);
  const before = jumps.length;
  await fireResize(view.settle);
  assert.deepEqual(
    jumps.slice(before),
    [`tail:${LAST}`],
    "back at the bottom by the reader's hand, the tail follows again",
  );
  await view.unmount();
});

test("re-opened thread: the open holds the row's top even while the pinned day pill is showing", async () => {
  jumps.length = 0;
  const view = await mount();
  const row = view.container.querySelector(
    `[data-testid="message-row-${ROOT}"]`,
  );
  assert.ok(row, "the threaded row renders");
  // The pinned pill is the wrapper's first child once the top row is not a
  // divider — the precondition the anchor lookup used to trip on.
  const wrap = view.scroller.parentElement;
  assert.notEqual(
    wrap.firstElementChild,
    view.scroller,
    "precondition: a pinned day pill sits before the scroller",
  );
  await click(chip(view.container));
  await view.settle(50);
  // Model the growth virtua compensates for: once the thread is open, the
  // row's top sits 300px higher than the scroll position alone explains.
  Object.defineProperty(view.scroller, "scrollTop", {
    configurable: true,
    writable: true,
    value: 1000,
  });
  const open = () => chip(view.container).getAttribute("aria-expanded");
  row.getBoundingClientRect = () => ({
    top: 200 - view.scroller.scrollTop - (open() === "true" ? 300 : 0),
  });
  await click(chip(view.container));
  await view.settle(300);
  assert.equal(
    view.scroller.scrollTop,
    700,
    "the anchor scrolls the list by the growth so the row stays where it was clicked",
  );
  await view.unmount();
});
