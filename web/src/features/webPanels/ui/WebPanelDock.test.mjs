import assert from "node:assert/strict";
import { after, test } from "node:test";

// iOS: NO IFRAMES. A framed site is third-party inside the app's WKWebView and
// WebKit drops its session cookie, so a cookie-auth site loops on sign-in. On
// native iOS the dock must open the active panel in the in-app browser and
// render a card instead; everywhere else the iframes stay. Mounted for real
// under jsdom + act (same harness as HuddleDock.test.mjs).

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
  // The dock is always handed its own store below; this default is unused.
  "../hooks.ts": `
    export function useWebPanelDock() { return null; }
  `,
  "./AddSiteDialog.tsx": `
    export function AddSiteDialog() { return null; }
  `,
  "@tanstack/react-router": `
    export function Link(props) {
      return globalThis.__BUZZ_TEST_REACT__.createElement("a", null, props.children);
    }
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WebPanelDock } = await import("./WebPanelDock.tsx");

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

const PANELS = [
  { id: "stash", label: "Stash", url: "https://stash.test/" },
  { id: "files", label: "Files", url: "https://files.test/" },
];

function fakeDock() {
  return {
    panels: PANELS,
    instances: [
      { instanceId: "i-stash", panelId: "stash" },
      { instanceId: "i-files", panelId: "files" },
    ],
    activeInstanceId: "i-stash",
    open: () => ({ ok: true }),
    focusOrOpen: () => ({ ok: true }),
    close: () => {},
    activate: () => {},
  };
}

async function mountDock() {
  globalThis.__BUZZ_TEST_IN_APP_OPENS__ = [];
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(WebPanelDock, {
        onClose: () => {},
        dock: fakeDock(),
      }),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const ACTIVE_URL = "https://stash.test/?theme=dark";

test("native iOS: no iframes, active panel opens in the in-app browser, in-app card shows", async () => {
  globalThis.__BUZZ_TEST_IS_IOS__ = true;
  const { container, unmount } = await mountDock();
  try {
    assert.equal(container.querySelectorAll("iframe").length, 0);
    assert.deepEqual(globalThis.__BUZZ_TEST_IN_APP_OPENS__, [ACTIVE_URL]);
    const card = container.querySelector('[data-testid="web-panel-in-app"]');
    assert.ok(card, "in-app card must render");
    const button = [...card.querySelectorAll("button")].find(
      (b) => b.textContent === "Open Stash",
    );
    assert.ok(button, "card must offer an 'Open Stash' button");
    await act(async () => {
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.deepEqual(globalThis.__BUZZ_TEST_IN_APP_OPENS__, [
      ACTIVE_URL,
      ACTIVE_URL,
    ]);
  } finally {
    await unmount();
  }
});

test("non-iOS: iframes still render for every tab and the in-app browser is not used", async () => {
  globalThis.__BUZZ_TEST_IS_IOS__ = false;
  const { container, unmount } = await mountDock();
  try {
    const frames = container.querySelectorAll("iframe");
    assert.equal(frames.length, 2);
    assert.equal(
      container
        .querySelector('[data-testid="web-panel-frame-i-stash"]')
        ?.getAttribute("src"),
      ACTIVE_URL,
    );
    assert.equal(
      container.querySelector('[data-testid="web-panel-in-app"]'),
      null,
    );
    assert.deepEqual(globalThis.__BUZZ_TEST_IN_APP_OPENS__, []);
  } finally {
    await unmount();
  }
});

// ── Focus mode (Sam, 2026-09-24: iPad Files dock too small to read) ─────────

const { AppShell } = await import("../../../shared/layout/AppShell.tsx");
const { DOCK_FOCUS_KEY, loadDockFocus, useDockFocusMode } = await import(
  "../lib/focusMode.ts"
);

/**
 * The real host wiring in miniature: repos.tsx holds `useDockFocusMode()`,
 * passes it to the dock, and makes AppShell chromeless while it is on.
 */
function FocusHost() {
  const [focused, setFocused] = useDockFocusMode();
  return React.createElement(
    AppShell,
    {
      chromeless: focused,
      sidebar: React.createElement("nav", { "data-testid": "sidebar-body" }),
    },
    React.createElement(WebPanelDock, {
      onClose: () => {
        globalThis.__BUZZ_TEST_DOCK_CLOSED__ = true;
      },
      dock: fakeDock(),
      focusMode: focused,
      onFocusModeChange: setFocused,
    }),
  );
}

async function mountFocusHost() {
  globalThis.__BUZZ_TEST_IS_IOS__ = false;
  globalThis.__BUZZ_TEST_DOCK_CLOSED__ = false;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FocusHost)));
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  const click = async (el) =>
    act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  return {
    q,
    click,
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

// focusMode.ts reads globalThis.localStorage; point it at jsdom's.
const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: dom.window.localStorage,
});
after(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
});

test("focus mode: maximize hides dock header + app sidebar, iframes survive, exit restores", async () => {
  dom.window.localStorage.clear();
  const { q, click, unmount } = await mountFocusHost();
  try {
    assert.ok(q("web-panel-dock-header"), "header shows before focus");
    assert.equal(q("web-panel-dock-unfocus"), null);
    assert.match(q("app-shell-sidebar").className, /md:flex/);
    const frameBefore = q("web-panel-frame-i-files");
    assert.ok(frameBefore);

    await click(q("web-panel-dock-focus"));

    assert.equal(q("web-panel-dock-header"), null, "header must be gone");
    assert.equal(q("app-shell-sidebar").className, "hidden");
    assert.match(q("app-shell-phone-bar").className, /(^| )hidden( |$)/);
    assert.equal(
      q("web-panel-frame-i-files"),
      frameBefore,
      "iframe must be the SAME node — hiding the header must not remount it",
    );
    assert.ok(q("sidebar-body"), "sidebar stays mounted (subscriptions)");
    assert.equal(dom.window.localStorage.getItem(DOCK_FOCUS_KEY), "1");

    const exit = q("web-panel-dock-unfocus");
    assert.ok(exit, "floating exit control shows in focus mode");
    assert.match(exit.className, /(^| )size-10( |$)/, ">=36px touch target");
    await click(exit);

    assert.ok(q("web-panel-dock-header"));
    assert.match(q("app-shell-sidebar").className, /md:flex/);
    assert.equal(q("web-panel-frame-i-files"), frameBefore);
    assert.equal(dom.window.localStorage.getItem(DOCK_FOCUS_KEY), null);
  } finally {
    await unmount();
  }
});

test("focus mode: Escape exits focus first, and only closes the dock on a second press", async () => {
  dom.window.localStorage.clear();
  const { q, click, unmount } = await mountFocusHost();
  try {
    await click(q("web-panel-dock-focus"));
    await pressEscape();
    assert.ok(q("web-panel-dock-header"), "Escape left focus mode");
    assert.equal(globalThis.__BUZZ_TEST_DOCK_CLOSED__, false);
    await pressEscape();
    assert.equal(globalThis.__BUZZ_TEST_DOCK_CLOSED__, true);
  } finally {
    await unmount();
  }
});

test("focus mode: persisted choice restores focus on the next mount", async () => {
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem(DOCK_FOCUS_KEY, "1");
  assert.equal(loadDockFocus(), true);
  const { q, unmount } = await mountFocusHost();
  try {
    assert.equal(q("web-panel-dock-header"), null);
    assert.equal(q("app-shell-sidebar").className, "hidden");
    assert.ok(q("web-panel-dock-unfocus"));
  } finally {
    await unmount();
    dom.window.localStorage.clear();
  }
});

test("focus mode: a dock without onFocusModeChange offers no maximize and ignores focusMode", async () => {
  globalThis.__BUZZ_TEST_IS_IOS__ = false;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(WebPanelDock, {
        onClose: () => {},
        dock: fakeDock(),
        focusMode: true,
      }),
    ),
  );
  try {
    assert.equal(
      container.querySelector('[data-testid="web-panel-dock-focus"]'),
      null,
    );
    assert.ok(container.querySelector('[data-testid="web-panel-dock-header"]'));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
