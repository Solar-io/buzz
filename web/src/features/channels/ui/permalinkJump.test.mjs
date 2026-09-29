import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Permalink jump (`?m=`) in the REAL ChannelTimeline, over a buffer that
 * GROWS underneath the jump.
 *
 * Live bug (2026-09-29, #general): Reminders → "Jump to message" opened the
 * channel with a short in-memory buffer that already held the target; the
 * full cached history was prepended a frame later. The timeline had resolved
 * the target's item index before that growth and applied it after, so the
 * list went to an OLD row (scrollTop 20984 of 170365, Sep 22) and `?m=` was
 * dropped anyway. A full page load was fine: its buffer arrives whole.
 *
 * The one stub is `virtua`: jsdom has no layout, so the real VList renders a
 * zero-item window (see cardAnswerWiring.test.mjs). The stand-in renders every
 * child, models a fixed geometry (10px rows, 100px viewport), and records
 * each scrollToIndex as the React KEY of the item at that index AT CALL TIME
 * — so an assertion names the row the list was actually sent to, not a
 * number whose meaning shifts with the buffer.
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
// jsdom has no scrolling; MessageRow's highlight effect calls this on mount.
dom.window.Element.prototype.scrollIntoView = () => {};
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
globalThis.__BUZZ_TEST_IDB__ ??= { data: new Map() };

/** Every scrollToIndex, as the key of the item it targeted. */
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
    const VIEWPORT = 100;
    export const VList = forwardRef(function VList(props, ref) {
      const items = React.Children.toArray(props.children);
      const itemsRef = useRef(items);
      itemsRef.current = items;
      const offsetRef = useRef(0);
      // The row centred in the viewport NOW. Offsets survive a prepend
      // unchanged (virtua without shift keeps scrollTop), so after the buffer
      // grows this names whatever row slid under the old offset — the live
      // failure's observable, not the row a past call aimed at.
      globalThis.__BUZZ_TEST_CENTER_KEY__ = () => {
        const index = Math.round((offsetRef.current + (VIEWPORT - ROW) / 2) / ROW);
        const item = itemsRef.current[index];
        return item ? String(item.key).replace(/^\\.\\$/, "") : "<none>";
      };
      useImperativeHandle(ref, () => ({
        scrollToIndex(index, opts) {
          const item = itemsRef.current[index];
          const key = item ? String(item.key).replace(/^\\.\\$/, "") : "<none>";
          // Tail scrolls (align "end") are recorded too, tagged, so "where
          // did the list END" sees them; permalink jumps align "center".
          globalThis.__BUZZ_TEST_JUMPS__.push(
            opts?.align === "center" ? key : "tail:" + key,
          );
          // FROZEN models a scroll that never took effect (hidden tab, a
          // virtualizer that lost the call): the offset stays put.
          if (!globalThis.__BUZZ_TEST_FROZEN__) {
            offsetRef.current = Math.max(0, index * ROW - (VIEWPORT - ROW) / 2);
          }
        },
        scrollTo() {},
        scrollBy() {},
        findItemIndex: (offset) => Math.floor(offset / ROW),
        getItemOffset: (index) => index * ROW,
        getItemSize: () => ROW,
        get scrollOffset() { return offsetRef.current; },
        get scrollSize() { return itemsRef.current.length * ROW; },
        viewportSize: VIEWPORT,
      }));
      return createElement("div", { className: props.className }, items);
    });
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { timelineMessageFromEvent } = await import("../lib/messageBuffer.ts");
const { TooltipProvider } = await import("@/shared/ui/tooltip");
const { ChannelTimeline } = await import("./ChannelTimeline.tsx");

const AUTHOR = "2".repeat(64);
const CHANNEL = "ch-1";
/** One day apart so every message also gets a day divider (more items). */
const DAY = 86_400;

function message(n) {
  const parsed = timelineMessageFromEvent({
    id: `msg-${String(n).padStart(3, "0")}`,
    pubkey: AUTHOR,
    kind: 9,
    created_at: 1_700_000_000 + n * DAY,
    content: `message ${n}`,
    tags: [["h", CHANNEL]],
    sig: "0".repeat(128),
  });
  assert.ok(parsed, `fixture message ${n} must parse`);
  return parsed;
}

/** Messages `from`..`to` inclusive, oldest first. */
function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => message(from + i));
}

const TARGET = "msg-097";
/** The short in-memory buffer an in-app navigation paints first. */
const SHORT = () => range(90, 99);
/** The whole cached history, landing a frame later. */
const FULL = () => range(0, 99);

/** Key of the row centred in the stand-in viewport right now. */
const centerKey = () => globalThis.__BUZZ_TEST_CENTER_KEY__();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(messages, extra = {}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next, more = {}) =>
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ChannelTimeline, {
        messages: next,
        profiles: new Map(),
        replyCounts: new Map(),
        showActions: false,
        tailKey: `${CHANNEL}:${next[next.length - 1].id}`,
        highlightId: TARGET,
        scrollToMessageId: TARGET,
        ...extra,
        ...more,
      }),
    );
  await act(async () => {
    root.render(render(messages));
  });
  return {
    container,
    rerender: async (next, more) => {
      await act(async () => {
        root.render(render(next, more));
      });
    },
    settle: async (ms) => {
      await act(async () => {
        await wait(ms);
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("harness: the stand-in list renders every row, and a jump is recorded", async () => {
  jumps.length = 0;
  const view = await mount(FULL());
  assert.equal(
    view.container.querySelectorAll('[data-testid^="message-row-"]').length,
    100,
    "all 100 fixture rows render (a zero-item window would make every assertion vacuous)",
  );
  await view.settle(400);
  assert.ok(
    jumps.length > 0,
    "the permalink issued at least one scrollToIndex",
  );
  assert.equal(jumps.at(-1), TARGET, "a whole buffer lands on the target");
  assert.equal(centerKey(), TARGET, "and the target is the row in view");
  await view.unmount();
});

test("buffer prepended right after mount: the list ends on the TARGET row, not a stale index", async () => {
  jumps.length = 0;
  const view = await mount(SHORT());
  // Same act tick as the mount's effects — before any rAF/timer fires. This
  // is the in-app navigation: short memory buffer, full history a frame later.
  await view.rerender(FULL());
  await view.settle(600);
  assert.ok(jumps.length > 0, "a jump was issued");
  assert.equal(
    jumps.at(-1),
    TARGET,
    `the last scroll targeted ${jumps.at(-1)}; every scroll: ${jumps.join(", ")}`,
  );
  assert.equal(centerKey(), TARGET, "the row in view is the target");
  await view.unmount();
});

test("buffer prepended AFTER the jump landed, while ?m= is still active: the list re-anchors", async () => {
  jumps.length = 0;
  const view = await mount(SHORT());
  await view.settle(400);
  assert.equal(jumps.at(-1), TARGET, "first landing on the short buffer");
  // Counted BEFORE the rerender: rendering 100 rows in jsdom is slow enough
  // that the next poll can fire inside the rerender's act().
  const before = jumps.length;
  await view.rerender(FULL());
  await view.settle(400);
  assert.ok(
    jumps.length > before,
    "the prepend shifted the target's index, so the list must be re-sent to it",
  );
  assert.equal(jumps.at(-1), TARGET);
  assert.equal(centerKey(), TARGET, "the row in view is the target");
  await view.unmount();
});

test("onScrollToMessageSettled fires only after the list was sent to the target row", async () => {
  jumps.length = 0;
  const settledWith = [];
  const view = await mount(SHORT(), {
    onScrollToMessageSettled: (id) => {
      settledWith.push({ id, lastJump: jumps.at(-1) });
    },
  });
  await view.rerender(FULL());
  await view.settle(600);
  assert.equal(settledWith.length, 1, "settled exactly once");
  assert.deepEqual(settledWith[0], { id: TARGET, lastJump: TARGET });
  await view.unmount();
});

test("a target that never enters the buffer is never reported settled", async () => {
  jumps.length = 0;
  const settled = [];
  const view = await mount(range(0, 20), {
    onScrollToMessageSettled: (id) => settled.push(id),
  });
  await view.settle(400);
  assert.ok(
    jumps.length > 0,
    "the auto-tail still scrolled (the recorder works)",
  );
  assert.deepEqual(
    jumps.filter((key) => !key.startsWith("tail:")),
    [],
    "no row, no permalink jump",
  );
  assert.deepEqual(settled, []);
  await view.unmount();
});

test("a jump that never moves the list is retried and never reported settled", async () => {
  jumps.length = 0;
  const settled = [];
  globalThis.__BUZZ_TEST_FROZEN__ = true;
  try {
    const view = await mount(FULL(), {
      onScrollToMessageSettled: (id) => settled.push(id),
    });
    await view.settle(500);
    const aimed = jumps.filter((key) => key === TARGET).length;
    assert.ok(
      aimed >= 2,
      `the jump is re-issued while the row is out of view (${aimed})`,
    );
    assert.notEqual(centerKey(), TARGET, "the stand-in really did not move");
    assert.deepEqual(settled, [], "not in view → not settled → ?m= stays");
    await view.unmount();
  } finally {
    globalThis.__BUZZ_TEST_FROZEN__ = false;
  }
});
