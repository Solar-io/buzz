import assert from "node:assert/strict";
import { test, after } from "node:test";

// AgentActivityPanel under jsdom + act. The blossom media boundary is
// stubbed (loader module-stub seam) so the portrait's signed fetch resolves
// deterministically; everything else is the real component tree.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  media: globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__,
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
  ro: globalThis.ResizeObserver,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Bare DOM constructors the components reference (the timeline's idiom):
// node:test runs bare, so they must be re-homed onto globalThis too.
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The auto-tail effect double-rAFs; queue and never flush — the scroll call
// it would make is irrelevant to these assertions.
const rafQueue = [];
globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
globalThis.cancelAnimationFrame = (id) => {
  rafQueue[id - 1] = null;
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/blossom": `
    export async function fetchSignedMedia(url) {
      const handler = globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__;
      if (!handler) {
        throw new Error("test did not install a media handler");
      }
      return handler(url);
    }
  `,
};

const { AgentActivityPanel } = await import("./AgentActivityPanel.tsx");

// jsdom has no ResizeObserver; the geometry re-pin (D-027) needs one.
// Instances are recorded so a test can fire a geometry change on demand.
// jsdom also has no Element.scrollTo (not even a no-op) — give it one so
// the component's tail/pin calls run; per-test recorders override it.
if (typeof dom.window.HTMLElement.prototype.scrollTo !== "function") {
  dom.window.HTMLElement.prototype.scrollTo = function () {};
}
const roInstances = [];
globalThis.ResizeObserver = class {
  #callback;
  constructor(callback) {
    this.#callback = callback;
    roInstances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  __fire() {
    this.#callback([], this);
  }
};

const PUBKEY = "c".repeat(64);

function turnFrame() {
  return {
    id: "frame-1",
    createdAt: 1_700_000_000,
    seq: 1,
    timestamp: "2023-11-14T22:13:20Z",
    kind: "turn_started",
    agentIndex: null,
    channelId: null,
    sessionId: null,
    turnId: "t1",
    payload: null,
  };
}

async function mountPanel({ profile, frames = [turnFrame()], ...rest }) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(AgentActivityPanel, {
        agentPubkey: PUBKEY,
        agentName: "Richard",
        profile,
        frames,
        lockedCount: 0,
        connected: true,
        working: { working: false, startedAt: null },
        mobileOpen: false,
        onCloseMobile: () => {},
        ...rest,
      }),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("the portrait no longer renders inside the thinking pane", async () => {
  // Sam's placement verdict (2026-09-14): a portrait at the top of this
  // scroll area is only visible at one scroll position — it moved to the
  // chat column as AgentPortraitOverlay. Pin the removal here so the block
  // cannot quietly come back; the header chip is unchanged.
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => "blob:mock-panel";
  const { container, unmount } = await mountPanel({
    profile: {
      name: "Richard",
      displayName: "Richard",
      avatar: "https://media.test/pic",
    },
  });

  assert.equal(
    container.querySelector('[data-testid="agent-portrait"]'),
    null,
    "the thinking pane must not render the portrait block",
  );

  // The "Thinking" header bar is gone (Sam, 2026-09-22) — pinned here so it
  // cannot quietly come back. The agent's identity still reaches the pane
  // while it is WORKING (avatar + badge above the transcript), and the pane
  // keeps the close control below lg, where the composer's brain toggle is
  // underneath the full-screen sheet and unreachable.
  assert.equal(
    container.querySelector("header"),
    null,
    "the thinking pane must not render a header bar",
  );
  assert.equal(
    container.textContent?.includes("Thinking"),
    false,
    'the word "Thinking" must not appear in the pane',
  );
  const close = container.querySelector(
    '[aria-label="Close thinking panel"]',
  );
  assert.ok(close, "the mobile close control survives the header removal");

  // The transcript still gets its rows (the turn divider from the frame).
  const transcript = container.querySelector("ol");
  assert.ok(transcript, "transcript list renders");
  assert.ok(
    transcript?.textContent?.includes("Turn"),
    "transcript rows still render",
  );
  await unmount();
});

test("the Replies switch is reachable at EVERY width, not just below lg", async () => {
  // The header bar's removal (Sam, 2026-09-22) moved the Replies switch into
  // a floating strip that ALSO carries the mobile close. The close genuinely
  // belongs below lg only (at lg the pane is docked and the composer's brain
  // toggle is visible), but the Replies switch does not: in a DM that has
  // both a thread and an agent it is the ONLY route back to Thinking, and the
  // reverse route sits on the thread pane. Sharing the close's `lg:hidden`
  // stranded every desktop reader who switched to Replies — this test exists
  // because that shipped once.
  //
  // The assertion is on the class list, not computed style: jsdom does not
  // evaluate Tailwind, so a visibility check here would pass on any markup
  // and prove nothing.
  const { container, unmount } = await mountPanel({
    onSelectThreadTab: () => {},
  });
  const replies = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Replies",
  );
  assert.ok(replies, "the Replies switch renders when a thread is available");
  assert.equal(
    replies.className.includes("lg:hidden"),
    false,
    "the Replies switch must not inherit the close's lg:hidden gate",
  );

  // The close keeps its own gate — the two are independent.
  const close = container.querySelector('[aria-label="Close thinking panel"]');
  assert.ok(close, "the mobile close still renders");
  assert.equal(
    close.className.includes("lg:hidden"),
    true,
    "the close stays below-lg only",
  );
  await unmount();
});

//
// D-027 wiring tests — the InputFollowState port observed through the real
// component tree. jsdom's scroll metrics are degenerate (0/0), which the
// engine tolerates: at-bottom reads true, so the PAUSE path (armed + upward
// movement, checked before the band) and the pin/no-pin observable carry the
// assertions. scrollTo is recorded per-instance because jsdom's is inert.
//

function panelScroller(container) {
  const scroller = container.querySelector(
    "div.buzz-channel-activity-scrollbar",
  );
  assert.ok(scroller, "pane scroller renders");
  return scroller;
}

function recordScrollTo(scroller) {
  const calls = [];
  scroller.scrollTo = (options) => calls.push(options);
  return calls;
}

function dispatchScroll(el) {
  el.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));
}

function dispatchWheel(el) {
  el.dispatchEvent(new dom.window.Event("wheel", { bubbles: true }));
}

/** Drain the queued-rAF pipeline (the harness never auto-flushes). */
function flushRafs() {
  for (let guard = 0; guard < 10; guard++) {
    const pending = rafQueue.splice(0).filter((cb) => cb !== null);
    if (pending.length === 0) {
      return;
    }
    for (const cb of pending) {
      cb();
    }
  }
}

/** Fire the pane's ResizeObserver once (a geometry change). */
function fireResizeObservers() {
  // Instances are created at mount and never re-created, so the LAST one
  // is this test's pane; earlier tests' stale instances fire no-ops (their
  // refs are nulled by unmount) and are skipped.
  const instance = roInstances[roInstances.length - 1];
  assert.ok(instance, "a ResizeObserver is mounted");
  instance.__fire();
}

test("the pane's own settling never pauses the tail (the D-027 regression)", async () => {
  // THE bug this port closes: an unarmed upward correction — the tail's own
  // settling, a late-sizing row — used to pause the old delta engine, and
  // every later frame landed below the fold. With InputFollowState, only a
  // reader's armed input can pause.
  const { container, unmount } = await mountPanel({});
  const scroller = panelScroller(container);
  // Drain the mount-time double-rAF tail before recording, so only the
  // interactions under test count.
  flushRafs();
  const pins = recordScrollTo(scroller);

  fireResizeObservers();
  flushRafs();
  assert.equal(pins.length, 1, "geometry change re-pins while following");

  // Programmatic upward correction, no reader input: 1000 → 400.
  scroller.scrollTop = 1000;
  dispatchScroll(scroller);
  scroller.scrollTop = 400;
  dispatchScroll(scroller);

  fireResizeObservers();
  flushRafs();
  assert.equal(
    pins.length,
    2,
    "an unarmed upward correction must NOT pause the tail",
  );
  await unmount();
});

test("a reader's armed input followed by upward movement pauses the tail", async () => {
  const { container, unmount } = await mountPanel({});
  const scroller = panelScroller(container);
  // Drain the mount-time double-rAF tail before recording, so only the
  // interactions under test count.
  flushRafs();
  const pins = recordScrollTo(scroller);

  scroller.scrollTop = 1000;
  dispatchScroll(scroller);
  dispatchWheel(scroller); // arms intent
  scroller.scrollTop = 400; // the armed input's upward movement
  dispatchScroll(scroller);

  fireResizeObservers();
  flushRafs();
  assert.equal(pins.length, 0, "paused: the geometry pin must not fire");

  // Scrolling back to the bottom resumes.
  scroller.scrollTop = 0;
  dispatchScroll(scroller);
  fireResizeObservers();
  flushRafs();
  assert.equal(pins.length, 1, "reaching the bottom resumes tailing");
  await unmount();
});

test("an inner scroller's scroll event does not feed the pane engine", async () => {
  // A horizontal code block inside a thinking entry is an inner scroller;
  // its scroll captures through the pane but must not touch the engine. If
  // it polluted prevScrollTop (child scrollTop 2000), the wheel below +
  // pane scroll to 1400 would read as "armed + upward" and pause.
  const { container, unmount } = await mountPanel({});
  const scroller = panelScroller(container);
  // Drain the mount-time double-rAF tail before recording, so only the
  // interactions under test count.
  flushRafs();
  const pins = recordScrollTo(scroller);

  const inner = dom.window.document.createElement("div");
  inner.style.overflowX = "auto";
  scroller.firstElementChild.appendChild(inner);

  scroller.scrollTop = 1000;
  dispatchScroll(scroller);
  inner.scrollTop = 2000;
  dispatchScroll(inner); // capture-phase through the pane wrapper
  dispatchWheel(scroller); // a real reader input arms…
  scroller.scrollTop = 1400; // …and the pane moves DOWN, not up
  dispatchScroll(scroller);

  fireResizeObservers();
  flushRafs();
  assert.equal(
    pins.length,
    1,
    "inner scroller events must not arm-and-pause the pane tail",
  );
  await unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    __BUZZ_TEST_FETCH_SIGNED_MEDIA__: originals.media,
    requestAnimationFrame: originals.raf,
    cancelAnimationFrame: originals.caf,
    ResizeObserver: originals.ro,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});
