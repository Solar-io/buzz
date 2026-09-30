import assert from "node:assert/strict";
import { after, test } from "node:test";

// The always-mounted web layer (plan items 3 + 4). Mounted for real under
// jsdom + act, driven by the REAL module store + reducer, so these tests
// exercise the shipped state path rather than a replica of it.

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

globalThis.__BUZZ_TEST_IS_IOS__ = false;
globalThis.__BUZZ_TEST_IN_APP_OPENS__ = [];

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/platform/native": `
    export const isNativeIOS = () => globalThis.__BUZZ_TEST_IS_IOS__;
  `,
  "@/shared/platform/native-navigation": `
    export function openInAppBrowser(url) {
      globalThis.__BUZZ_TEST_IN_APP_OPENS__.push(url);
    }
  `,
  "@/shared/theme/ThemeProvider": `
    export function useTheme() { return { isDark: true }; }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WebFrameHost } = await import("./WebFrameHost.tsx");
const { useActiveWebView, dispatchActiveWeb, resetActiveWebForTests } =
  await import("../activeWebStore.ts");
const { AppShell } = await import("../../../shared/layout/AppShell.tsx");
const { openInFiles, useFilesPathRequest, resetFilesPathForTests } =
  await import("../filesPathStore.ts");

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.HTMLElement = originals.HTMLElement;
  globalThis.Node = originals.Node;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  dom.window.close();
});

const PANELS = new Map([
  ["link:a", { id: "a", label: "Alpha", url: "https://a.test/" }],
  ["link:b", { id: "b", label: "Bravo", url: "https://b.test/" }],
  ["link:c", { id: "c", label: "Charlie", url: "https://c.test/" }],
  ["files:files", { id: "files", label: "Files", url: "https://files.test/" }],
]);
const resolve = (key) => PANELS.get(key) ?? null;

/** The shell wiring in miniature: store → AppShell chromeless + host. */
function Shell() {
  const web = useActiveWebView();
  const filesPath = useFilesPathRequest();
  return React.createElement(
    AppShell,
    {
      chromeless: web.state.active !== null && web.state.focus,
      sidebar: React.createElement("nav", { "data-testid": "sidebar-body" }),
    },
    React.createElement(
      "div",
      { className: "relative h-full min-h-0" },
      React.createElement("section", { "data-testid": "conversation" }),
      React.createElement(WebFrameHost, {
        state: web.state,
        resolve,
        onFocusModeChange: web.setFocus,
        onHide: web.hide,
        filesPath,
        fallback: React.createElement("div", { "data-testid": "fallback" }),
      }),
    ),
  );
}

async function mount() {
  resetActiveWebForTests();
  resetFilesPathForTests();
  globalThis.__BUZZ_TEST_IN_APP_OPENS__ = [];
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Shell)));
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  return {
    container,
    q,
    show: (kind, panelId) =>
      act(async () =>
        dispatchActiveWeb({ type: "show", target: { kind, panelId } }),
      ),
    hide: () => act(async () => dispatchActiveWeb({ type: "hide" })),
    click: (el) =>
      act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      }),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const pressEscape = () =>
  act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape" }),
    );
  });

test("bar above the page: exactly Full screen + Open in new tab, no tab strip", async () => {
  const { q, show, unmount } = await mount();
  try {
    await show("link", "a");
    const header = q("web-panel-dock-header");
    assert.ok(header);
    const controls = header.querySelectorAll("button, a");
    assert.equal(controls.length, 2);
    assert.equal(controls[0].getAttribute("aria-label"), "Full screen");
    assert.equal(
      controls[1].getAttribute("aria-label"),
      "Open Alpha in a new tab",
    );
    assert.equal(controls[1].getAttribute("href"), "https://a.test/");
    assert.equal(controls[1].getAttribute("target"), "_blank");
    assert.equal(header.ownerDocument.querySelector('[role="tablist"]'), null);
  } finally {
    await unmount();
  }
});

test("link A then link B: B shows at once, A's iframe is the same live node", async () => {
  const { q, show, unmount } = await mount();
  try {
    await show("link", "a");
    const frameA = q("web-panel-frame-link:a");
    assert.ok(frameA);
    await show("link", "b");
    const frameB = q("web-panel-frame-link:b");
    assert.ok(frameB, "B mounted on the second click (no openedOnce stall)");
    assert.match(frameB.className, /(^| )z-10( |$)/, "B visible");
    assert.equal(q("web-panel-frame-link:a"), frameA, "A kept, not remounted");
    assert.match(frameA.className, /opacity-0/);
    assert.equal(frameA.hasAttribute("inert"), true);
  } finally {
    await unmount();
  }
});

test("back to A after B: no DOM move (a moved iframe reloads)", async () => {
  const { container, q, show, unmount } = await mount();
  try {
    await show("link", "b");
    await show("link", "a");
    const order = () =>
      [...container.querySelectorAll("iframe")].map((f) => f.dataset.testid);
    const before = order();
    const frameA = q("web-panel-frame-link:a");
    await show("link", "b");
    await show("link", "a");
    assert.deepEqual(order(), before, "frame DOM order is stable");
    assert.equal(q("web-panel-frame-link:a"), frameA);
  } finally {
    await unmount();
  }
});

test("a conversation click hides the layer without unmounting its frames", async () => {
  const { q, show, hide, unmount } = await mount();
  try {
    await show("files", "files");
    await show("link", "a");
    const frame = q("web-panel-frame-link:a");
    await hide();
    const host = q("web-frame-host");
    assert.equal(host.hasAttribute("inert"), true);
    assert.match(host.className, /invisible/);
    assert.equal(q("web-panel-frame-link:a"), frame);
    assert.ok(q("web-panel-frame-files:files"));
    assert.ok(q("conversation"), "conversation pane is always mounted");
  } finally {
    await unmount();
  }
});

test("full screen hides the sidebar; switching page brings the sidebar back", async () => {
  const { q, show, click, unmount } = await mount();
  try {
    await show("link", "a");
    await click(q("web-panel-dock-focus"));
    assert.equal(q("app-shell-sidebar").className, "hidden");
    assert.equal(q("web-panel-dock-header"), null);
    await show("link", "b");
    assert.match(q("app-shell-sidebar").className, /md:flex/);
    assert.ok(q("web-panel-dock-header"));
  } finally {
    await unmount();
  }
});

test("Escape leaves full screen first, then returns to the conversation", async () => {
  const { q, show, click, unmount } = await mount();
  try {
    await show("link", "a");
    await click(q("web-panel-dock-focus"));
    await pressEscape();
    assert.ok(q("web-panel-dock-header"), "left full screen");
    assert.equal(q("web-frame-host").hasAttribute("inert"), false);
    await pressEscape();
    assert.equal(
      q("web-frame-host").hasAttribute("inert"),
      true,
      "layer hidden",
    );
  } finally {
    await unmount();
  }
});

test("7 distinct pages in a row: each shows, at most 4 iframes in the DOM", async () => {
  const { container, q, show, unmount } = await mount();
  try {
    for (const id of ["a", "b", "c", "a", "b", "c", "a"]) {
      await show("link", id);
      assert.match(q(`web-panel-frame-link:${id}`).className, /z-10/);
    }
    await show("files", "files");
    for (const id of ["x1", "x2", "x3"]) {
      await show("link", id);
    }
    assert.ok(container.querySelectorAll("iframe").length <= 4);
  } finally {
    await unmount();
  }
});

test("an active target with no panel renders the fallback (Files setup)", async () => {
  const { q, show, unmount } = await mount();
  try {
    await show("files", "unconfigured");
    assert.ok(q("fallback"));
    assert.equal(q("web-panel-dock-header"), null);
  } finally {
    await unmount();
  }
});

test("native iOS: no iframes; the active page opens in the in-app browser", async () => {
  globalThis.__BUZZ_TEST_IS_IOS__ = true;
  const { container, q, show, unmount } = await mount();
  try {
    await show("link", "a");
    assert.equal(container.querySelectorAll("iframe").length, 0);
    assert.deepEqual(globalThis.__BUZZ_TEST_IN_APP_OPENS__, [
      "https://a.test/?theme=dark",
    ]);
    assert.ok(q("web-panel-in-app"));
  } finally {
    globalThis.__BUZZ_TEST_IS_IOS__ = false;
    await unmount();
  }
});

// ── Phase 4: Files embedded, with Buzz's live theme (stash §4.2) ─────────────

const root = dom.window.document.documentElement;
/** A buzz-dark-ish root: the class ThemeProvider sets, and two resolved vars. */
function paintRoot(background) {
  root.classList.remove("light", "dark");
  root.classList.add("dark");
  root.style.setProperty("--background", background);
  root.style.setProperty("--foreground", "40 11.11% 89.4%");
}
/** Replace a frame's postMessage with a recorder. */
function spyOn(frame) {
  const calls = [];
  frame.contentWindow.postMessage = (message, targetOrigin) =>
    calls.push({ message, targetOrigin });
  return calls;
}
/** Deliver a message to the parent window as if `frame` sent it. */
const fromFrame = (frame, data, origin) =>
  act(async () => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data,
        origin,
        source: frame.contentWindow,
      }),
    );
  });
/** Let the MutationObserver + frame-coalesced push run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

test("files:ready from the Files frame is answered with the theme, at the panel's exact origin", async () => {
  paintRoot("0 0% 7.8%");
  const { q, show, unmount } = await mount();
  try {
    await show("files", "files");
    const frame = q("web-panel-frame-files:files");
    assert.equal(frame.getAttribute("data-buzz-theme-push"), "true");
    const calls = spyOn(frame);
    await fromFrame(frame, { type: "files:ready", v: 1 }, "https://files.test");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetOrigin, "https://files.test");
    const { message } = calls[0];
    assert.equal(message.type, "buzz:theme");
    assert.equal(message.v, 1);
    assert.equal(message.source, "buzz");
    assert.equal(message.mode, "dark");
    assert.equal(message.tokens.background, "hsl(0 0% 7.8%)");
    assert.equal(message.tokens.foreground, "hsl(40 11.11% 89.4%)");
  } finally {
    await unmount();
  }
});

test("files:ready from another origin, or from a link frame, gets nothing", async () => {
  paintRoot("0 0% 7.8%");
  const { q, show, unmount } = await mount();
  try {
    await show("link", "a");
    await show("files", "files");
    const files = q("web-panel-frame-files:files");
    const link = q("web-panel-frame-link:a");
    assert.equal(link.hasAttribute("data-buzz-theme-push"), false);
    const filesCalls = spyOn(files);
    const linkCalls = spyOn(link);
    // Right frame, wrong origin (the frame navigated, or a forged sender).
    await fromFrame(files, { type: "files:ready" }, "https://evil.test");
    // A link frame announcing itself as Files.
    await fromFrame(link, { type: "files:ready" }, "https://a.test");
    // Right origin, wrong message.
    await fromFrame(files, { type: "hello" }, "https://files.test");
    assert.deepEqual(filesCalls, []);
    assert.deepEqual(linkCalls, []);
  } finally {
    await unmount();
  }
});

test("a theme switch repaints Files in place: pushed at its origin, never reloaded; links untouched", async () => {
  paintRoot("0 0% 7.8%");
  const { q, show, unmount } = await mount();
  try {
    await show("link", "a");
    await show("files", "files");
    const files = q("web-panel-frame-files:files");
    const srcBefore = files.getAttribute("src");
    const filesCalls = spyOn(files);
    const linkCalls = spyOn(q("web-panel-frame-link:a"));
    // buzz-dark → buzz-light, the way ThemeProvider lands it on <html>.
    await act(async () => {
      root.classList.remove("dark");
      root.classList.add("light");
      root.style.setProperty("--background", "45 50.00% 98.4%");
    });
    await settle();
    assert.equal(filesCalls.length, 1, "one push for one switch");
    assert.equal(filesCalls[0].targetOrigin, "https://files.test");
    assert.equal(filesCalls[0].message.mode, "light");
    assert.equal(
      filesCalls[0].message.tokens.background,
      "hsl(45 50.00% 98.4%)",
    );
    assert.deepEqual(linkCalls, [], "a link site gets no theme push");
    assert.equal(q("web-panel-frame-files:files"), files, "same live node");
    assert.equal(files.getAttribute("src"), srcBefore, "src unchanged");
    // The same theme written again is not a change.
    await act(async () => {
      root.style.setProperty("--background", "45 50.00% 98.4%");
    });
    await settle();
    assert.equal(filesCalls.length, 1);
  } finally {
    paintRoot("0 0% 7.8%");
    await unmount();
  }
});

test("a Files frame boots on the theme: ?theme= plus the #buzz-theme fragment", async () => {
  paintRoot("0 0% 7.8%");
  const { q, show, unmount } = await mount();
  try {
    await show("files", "files");
    const src = new URL(q("web-panel-frame-files:files").getAttribute("src"));
    assert.equal(src.origin, "https://files.test");
    assert.equal(src.searchParams.get("theme"), "dark");
    assert.match(src.hash, /^#buzz-theme=[A-Za-z0-9_-]+$/);
    const body = JSON.parse(
      Buffer.from(
        src.hash.slice(12).replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    );
    assert.equal(body.tokens.background, "hsl(0 0% 7.8%)");
  } finally {
    await unmount();
  }
});

test("Files: no bar above the page; its two controls float bottom-right", async () => {
  const { q, show, click, unmount } = await mount();
  try {
    await show("files", "files");
    assert.equal(
      q("web-panel-dock-header"),
      null,
      "the Files header is stash's",
    );
    const controls = q("web-panel-files-controls");
    assert.ok(controls);
    const items = controls.querySelectorAll("button, a");
    assert.equal(items.length, 2);
    assert.equal(items[0].getAttribute("aria-label"), "Full screen");
    assert.equal(
      items[1].getAttribute("aria-label"),
      "Open Files in a new tab",
    );
    assert.equal(items[1].getAttribute("href"), "https://files.test/");
    await click(q("web-panel-dock-focus"));
    assert.equal(q("web-panel-files-controls"), null, "full screen: Exit only");
    assert.ok(q("web-panel-dock-unfocus"));
  } finally {
    await unmount();
  }
});

test("Open in Files loads the Files frame on that folder, once per request", async () => {
  const { q, show, unmount } = await mount();
  try {
    await show("files", "files");
    const before = q("web-panel-frame-files:files");
    await act(async () => {
      assert.equal(openInFiles("/Users/sam/Dropbox/rts-bakeoff"), true);
    });
    const loaded = q("web-panel-frame-files:files");
    assert.notEqual(loaded, before, "stash reads ?path= at boot: a fresh load");
    const src = new URL(loaded.getAttribute("src"));
    assert.equal(
      src.searchParams.get("path"),
      "/Users/sam/Dropbox/rts-bakeoff",
    );
    assert.equal(loaded.getAttribute("data-buzz-theme-push"), "true");
    // Away and back: the same frame, not a second load.
    await show("link", "a");
    await show("files", "files");
    assert.equal(q("web-panel-frame-files:files"), loaded);
    // A bad path changes nothing.
    await act(async () => {
      assert.equal(openInFiles("~/Dropbox"), false);
    });
    assert.equal(q("web-panel-frame-files:files"), loaded);
  } finally {
    await unmount();
  }
});
