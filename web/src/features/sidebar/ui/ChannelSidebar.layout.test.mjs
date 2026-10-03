import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * The left rail's layout after Sam's 2026-09-30 pass, driven through the
 * REAL ChannelSidebar:
 *
 *  1. no profile row at the foot, and no "crichton · relay" line;
 *  2. Settings (and everything the profile row's menu held) opens from the
 *     B at the top-left;
 *  3. Vitals is the last thing in the rail, where the profile row was;
 *  4. Forums and Links are nav rows right under Terminal — not list
 *     sections — that start folded and open on click.
 *
 * Stubbed: the relay session / signer / theme seams (as in
 * SidebarShortcutsSection.test.mjs), the router (Link renders an <a> with
 * its target), and two self-wired leaves the rail only PLACES — Vitals and
 * the Terminal row — as markers, so these cases assert the rail's order and
 * not the usage math or the hatch config.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
delete globalThis.localStorage;
globalThis.localStorage = dom.window.localStorage;

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
      // A non-configurable Node global we must not (and need not) shadow.
    }
  }
}
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

// A relay with nothing stored: every REQ ends at EOSE, every publish is ok.
globalThis.__BUZZ_TEST_RELAY_SESSION__ = {
  subscribe(_filter, options) {
    queueMicrotask(() => options?.onEose?.());
    return () => {};
  },
  async publish() {
    return { ok: true, message: "" };
  },
};

// React comes off a global: a stub module's URL is not a file URL, so a
// bare `import "react"` inside one cannot resolve (StageView.test.mjs).
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_RELAY_SESSION__, status: "open" };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  "@/shared/theme/ThemeProvider": `
    export function useTheme() { return { isDark: true }; }
    export function ThemeProvider({ children }) { return children ?? null; }
  `,
  sonner: `
    export const toast = { error() {}, success() {}, info() {} };
  `,
  "@tanstack/react-router": `
    const { createElement } = globalThis.__BUZZ_TEST_REACT__;
    export function Link({ to, search, children, onClick, className }) {
      const query = search && search.view ? "?view=" + search.view : "";
      return createElement(
        "a",
        {
          href: to + query,
          className,
          onClick: (event) => {
            event.preventDefault();
            if (onClick) onClick(event);
          },
        },
        children,
      );
    }
    export function useNavigate() { return () => Promise.resolve(); }
    export function useSearch() { return undefined; }
    export function useRouter() { return { navigate() {} }; }
    export function useBlocker() { return { status: "idle" }; }
  `,
  // The app's route tree: reached through the shell modules the rail
  // imports (AppShell, huddle chrome), never navigated by these cases.
  "@/app/router": `
    export const router = { navigate() { return Promise.resolve(); } };
  `,
  "@/features/vitals/ui/VitalsBlock": `
    const { createElement } = globalThis.__BUZZ_TEST_REACT__;
    export function VitalsBlock() {
      return createElement("div", { "data-testid": "vitals-block" }, "Claude 15% free");
    }
  `,
  "@/features/terminal/ui/TerminalNavButton": `
    const { createElement } = globalThis.__BUZZ_TEST_REACT__;
    export function TerminalNavButton() {
      return createElement("button", { type: "button", "data-testid": "terminal-nav" }, "Terminal");
    }
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { ChannelSidebar } = await import("./ChannelSidebar.tsx");
const { dispatchActiveWeb, resetActiveWebForTests } = await import(
  "../../webPanels/activeWebStore.ts"
);

const COLLAPSED_KEY = "buzz.collapsed-sections.v1";
const SELF = "ab".repeat(32);

function channel(id, name, type, updatedAt = 1_000) {
  return {
    id,
    name,
    about: "",
    updatedAt,
    type,
    archived: false,
    isPrivate: false,
    topic: "",
    purpose: "",
    ttlDeadline: null,
    ttlSeconds: null,
    participantPubkeys: [],
  };
}

const STREAM = channel("c-flight", "flight-path", "stream");
const FORUM_READ = channel("f-alerts", "system_alerts", "forum");
const FORUM_UNREAD = channel("f-ideas", "ideas-board", "forum");

const noop = () => {};

function props({ forums = [FORUM_READ, FORUM_UNREAD], favorites = [] } = {}) {
  return {
    connected: true,
    relayStatus: "open",
    channelCount: 1 + forums.length,
    selectedId: undefined,
    inboxSelected: false,
    asksCount: 0,
    workSelected: false,
    needsCount: 0,
    itemsSelected: false,
    itemCounts: null,
    lists: {
      streams: [STREAM],
      forums,
      scratch: [],
      dms: [],
      visibleDms: [],
    },
    readState: {
      prefs: { favorites, muted: [] },
      // flight-path and system_alerts are read; ideas-board is not.
      read: { "c-flight": 5_000, "f-alerts": 5_000 },
      activity: new Map(),
      unreadCounts: new Map(),
    },
    search: { query: "", onQueryChange: noop, onFocus: noop },
    dmIdentity: {
      selfPubkey: SELF,
      profiles: new Map([[SELF, { displayName: "Sam Gallant" }]]),
      presence: new Map(),
      contacts: [],
    },
    dialogs: {
      newChannelOpen: false,
      onNewChannelOpenChange: noop,
      newDmOpen: false,
      onNewDmOpenChange: noop,
    },
    actions: {
      onSelectChannel: noop,
      channelMenuItems: () => [],
      onChannelCreated: noop,
      onDmOpened: noop,
      onHideDm: noop,
      onSetFavorite: noop,
      onOpenFiles: noop,
      onOpenInbox: noop,
      onOpenWork: noop,
      onOpenItems: noop,
      onOpenShortcutOverlay: noop,
    },
  };
}

async function mount(overrides) {
  resetActiveWebForTests();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  // retry: false — a query that cannot answer in jsdom fails once, quietly.
  // gcTime: Infinity — the default 5-minute cache GC is a live timer that
  // holds the test process open long after the last case finishes.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ChannelSidebar, props(overrides)),
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  const sidebar = () =>
    container.querySelector('[data-testid="channel-sidebar"]');
  /** A Forums / Links nav row's button, by its label. */
  const navRow = (label) =>
    Array.from(
      container.querySelectorAll(
        '[data-testid="sidebar-nav-disclosure"] > button',
      ),
    ).find((button) => button.textContent.startsWith(label));
  return {
    container,
    sidebar,
    navRow,
    click: async (node, what) => {
      assert.ok(node, `${what} must exist to be clicked`);
      await act(async () => {
        node.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
}

// jsdom's own window timers (the status hooks' refresh) die with the window.
after(() => dom.window.close());

/** True when `a` comes before `b` in document order. */
function precedes(a, b) {
  return Boolean(
    a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

test("Daily Digest sits between Forums and Links and selects through the real web store", async () => {
  dom.window.localStorage.clear();
  const view = await mount();
  try {
    const digest = Array.from(view.sidebar().querySelectorAll("button")).find(
      (button) => button.textContent === "Daily Digest",
    );
    assert.ok(digest, "Daily Digest renders even with no saved Links");
    assert.ok(precedes(view.navRow("Forums"), digest), "below Forums");
    assert.ok(precedes(digest, view.navRow("Links")), "above Links");
    assert.equal(digest.getAttribute("data-active"), "false");
    await view.click(digest, "Daily Digest");
    assert.equal(digest.getAttribute("data-active"), "true");
    await act(async () => dispatchActiveWeb({ type: "hide" }));
    assert.equal(digest.getAttribute("data-active"), "false");
  } finally {
    await view.unmount();
  }
});

test("the rail has no profile row and no relay label, and Vitals is the last thing in it", async () => {
  dom.window.localStorage.clear();
  const view = await mount();
  try {
    const rail = view.sidebar();
    assert.ok(rail, "the sidebar mounts");
    assert.doesNotMatch(rail.textContent, /relay/i, "no 'crichton · relay'");
    assert.equal(
      rail.querySelector('[aria-label^="You:"]'),
      null,
      "the avatar / profile row is gone",
    );
    // The removed row's identity must not survive as a bare name either:
    // it lives in the B menu now, which is closed.
    assert.doesNotMatch(rail.textContent, /Sam Gallant/);
    const footer = rail.querySelector("footer");
    assert.ok(footer, "the rail keeps its fixed footer");
    assert.equal(
      footer.lastElementChild?.getAttribute("data-testid"),
      "vitals-block",
      "Vitals closes the rail, in the slot the profile row held",
    );
    assert.equal(
      footer.querySelectorAll("button").length,
      0,
      "nothing clickable left in the footer but Vitals (no install offer in jsdom)",
    );
  } finally {
    await view.unmount();
  }
});

test("Settings opens from the B at the top-left, with everything the profile menu held", async () => {
  dom.window.localStorage.clear();
  const view = await mount();
  try {
    const trigger = view
      .sidebar()
      .querySelector('[data-testid="sidebar-app-menu"]');
    assert.ok(trigger, "the B is a button");
    assert.match(trigger.textContent, /^B/, "the trigger IS the B mark");
    assert.ok(
      precedes(
        trigger,
        view.sidebar().querySelector('input[placeholder="Jump to…"]'),
      ),
      "the B sits above the Jump field, at the top of the rail",
    );
    assert.equal(
      dom.window.document.querySelector('a[href="/repos/settings"]'),
      null,
      "the menu is closed until the B is clicked",
    );
    await view.click(trigger, "the B button");
    const settings = dom.window.document.querySelector(
      'a[href="/repos/settings"]',
    );
    assert.ok(settings, "Settings is in the B menu");
    assert.match(settings.textContent, /Settings/);
    const menu = dom.window.document.body.textContent;
    for (const item of [
      "Notifications",
      "Projects",
      "Pulse",
      "Reminders",
      "Workflows",
      "Files",
      "Copy your npub",
    ]) {
      assert.ok(menu.includes(item), `${item} is still reachable`);
    }
    assert.match(menu, /Set a status/);
    assert.match(menu, /Sam Gallant/, "the menu says who you are signed in as");
  } finally {
    await view.unmount();
  }
});

test("Forums and Links are nav rows right under Terminal, folded until clicked", async () => {
  dom.window.localStorage.clear();
  const view = await mount();
  try {
    const rail = view.sidebar();
    const terminal = rail.querySelector('[data-testid="terminal-nav"]');
    const forums = view.navRow("Forums");
    const links = view.navRow("Links");
    const channels = rail.querySelector('section[aria-label="Channels"]');
    assert.ok(terminal && forums && links && channels, "all four render");
    assert.ok(precedes(terminal, forums), "Forums comes after Terminal");
    assert.ok(precedes(forums, links), "Links comes after Forums");
    assert.ok(precedes(links, channels), "both sit above the Channels list");
    // Nav rows, not the old list sections.
    assert.equal(rail.querySelector('section[aria-label="Forums"]'), null);
    assert.equal(rail.querySelector('section[aria-label="Links"]'), null);

    // Folded: say how many and that one is unread, show none of them.
    assert.equal(forums.getAttribute("aria-expanded"), "false");
    assert.equal(links.getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(rail.textContent, /system_alerts|ideas-board/);
    assert.equal(
      forums.querySelector('[data-testid="nav-disclosure-count"]')?.textContent,
      "2",
    );
    assert.ok(
      forums.querySelector('[data-testid="nav-disclosure-unread"]'),
      "a folded row still says something inside is unread",
    );
    assert.equal(
      links.querySelector('[data-testid="nav-disclosure-count"]'),
      null,
      "an empty Links row shows no 0",
    );
    assert.equal(
      rail.querySelector('button[aria-label="Add a link"]'),
      null,
      "folded Links hides its add row",
    );

    await view.click(forums, "the Forums row");
    assert.equal(view.navRow("Forums").getAttribute("aria-expanded"), "true");
    assert.match(rail.textContent, /system_alerts/);
    assert.match(rail.textContent, /ideas-board/);
    assert.equal(
      view
        .navRow("Forums")
        .querySelector('[data-testid="nav-disclosure-unread"]'),
      null,
      "open, the unread dot moves onto the row that is unread",
    );

    await view.click(links, "the Links row");
    assert.equal(view.navRow("Links").getAttribute("aria-expanded"), "true");
    assert.ok(
      rail.querySelector('button[aria-label="Add a link"]'),
      "open Links offers Add a link, even with no links",
    );

    const stored = JSON.parse(
      dom.window.localStorage.getItem(COLLAPSED_KEY) ?? "[]",
    );
    assert.ok(stored.includes("open:nav:forums"), "the open state persists");
    assert.ok(stored.includes("open:nav:links"));

    await view.click(view.navRow("Forums"), "the Forums row again");
    assert.equal(view.navRow("Forums").getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(rail.textContent, /system_alerts/);
  } finally {
    await view.unmount();
  }
});

test("a device that had opened the old Forums / Links sections still starts them folded", async () => {
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem(
    COLLAPSED_KEY,
    JSON.stringify(["open:forums", "open:links"]),
  );
  const view = await mount();
  try {
    assert.equal(view.navRow("Forums").getAttribute("aria-expanded"), "false");
    assert.equal(view.navRow("Links").getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(view.sidebar().textContent, /system_alerts/);
  } finally {
    await view.unmount();
  }
});

test("no forums, no Forums row; Links stays so a first link can be added", async () => {
  dom.window.localStorage.clear();
  const view = await mount({ forums: [] });
  try {
    assert.equal(view.navRow("Forums"), undefined);
    assert.ok(view.navRow("Links"));
  } finally {
    await view.unmount();
  }
});

test("Favorites sit under the Forums / Links rows and above Channels, and only exist when something is favorited", async () => {
  // Phone and desktop render this same rail; Sam's phone showed no
  // Favorites because favorites live in THIS device's localStorage
  // (channelPrefs.ts), not because the rail hides them there.
  dom.window.localStorage.clear();
  const view = await mount({
    favorites: [
      { kind: "channel", id: "c-flight" },
      { kind: "channel", id: "f-alerts" },
    ],
  });
  try {
    const rail = view.sidebar();
    const favorites = rail.querySelector('section[aria-label="Favorites"]');
    const channels = rail.querySelector('section[aria-label="Channels"]');
    assert.ok(favorites, "a Favorites section");
    assert.ok(channels, "a Channels section");
    assert.match(favorites.textContent, /flight-path/);
    assert.match(favorites.textContent, /system_alerts/);
    assert.doesNotMatch(
      channels.textContent,
      /flight-path/,
      "a favorite leaves its home section",
    );
    assert.ok(precedes(view.navRow("Links"), favorites), "under Links");
    assert.ok(precedes(favorites, channels), "above Channels");
    assert.match(
      view.navRow("Forums").textContent,
      /^Forums1/,
      "the favorited forum left the Forums count",
    );
  } finally {
    await view.unmount();
  }

  const empty = await mount();
  try {
    assert.equal(
      empty.sidebar().querySelector('section[aria-label="Favorites"]'),
      null,
      "nothing favorited: no empty Favorites header",
    );
  } finally {
    await empty.unmount();
  }
});
