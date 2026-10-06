/**
 * jsdom harness for tests that render the REAL left rail (ChannelSidebar,
 * DmNavRow, SidebarSection) — the environment ChannelSidebar.layout.test.mjs
 * established, shared so the unread invariant tests (I1, I4, I5) drive the
 * same components the app ships instead of a replica.
 *
 * Import it FIRST (it installs globals and module stubs before anything
 * React-shaped loads). The relay session the rail's hooks see is
 * `globalThis.__BUZZ_TEST_RELAY_SESSION__`: by default a relay with nothing
 * stored; a test may replace it with a real RelaySession on a fake socket.
 */
import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", {
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

/** A relay with nothing stored: every REQ ends at EOSE, every publish ok. */
export const EMPTY_RELAY = {
  subscribe(_filter, options) {
    queueMicrotask(() => options?.onEose?.());
    return () => {};
  },
  async publish() {
    return { ok: true, message: "" };
  },
};
globalThis.__BUZZ_TEST_RELAY_SESSION__ = EMPTY_RELAY;

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
  // Toasts land on globalThis.__BUZZ_TEST_ON_TOAST__ (spec), when a test
  // installs one; render() is sonner's own call into BuzzToast.
  sonner: `
    export const toast = {
      error() {}, success() {}, info() {}, warning() {}, message() {},
      dismiss() {},
      custom(render) {
        const element = render("test-toast");
        globalThis.__BUZZ_TEST_ON_TOAST__?.(element.props.spec);
        return "test-toast";
      },
    };
    export function Toaster() { return null; }
  `,
  "@tanstack/react-router": `
    const { createElement } = globalThis.__BUZZ_TEST_REACT__;
    export function Link({ to, children, className }) {
      return createElement("a", { href: to, className }, children);
    }
    export function useNavigate() { return () => Promise.resolve(); }
    export function useSearch() { return undefined; }
    export function useRouter() { return { navigate() {} }; }
    export function useBlocker() { return { status: "idle" }; }
  `,
  "@/app/router": `
    export const router = { navigate() { return Promise.resolve(); } };
  `,
  "@/features/vitals/ui/VitalsBlock": `
    export function VitalsBlock() { return null; }
  `,
  "@/features/terminal/ui/TerminalNavButton": `
    export function TerminalNavButton() { return null; }
  `,
};

export const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
export const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);

/** A channel summary with plausible defaults. */
export function channel(id, name, type = "stream", extra = {}) {
  return {
    id,
    name,
    about: "",
    updatedAt: 1_000,
    type,
    archived: false,
    isPrivate: type === "dm",
    topic: "",
    purpose: "",
    ttlDeadline: null,
    ttlSeconds: null,
    participantPubkeys: [],
    ...extra,
  };
}

const noop = () => {};

/** ChannelSidebar props with every required seam filled. */
export function sidebarProps(overrides = {}) {
  const base = {
    connected: true,
    relayStatus: "open",
    channelCount: 1,
    selectedId: undefined,
    inboxSelected: false,
    asksCount: 0,
    workSelected: false,
    needsCount: 0,
    itemsSelected: false,
    itemCounts: null,
    lists: { streams: [], forums: [], scratch: [], dms: [], visibleDms: [] },
    readState: {
      prefs: { favorites: [], muted: [] },
      read: {},
      activity: new Map(),
      unreadCounts: new Map(),
    },
    search: { query: "", onQueryChange: noop, onFocus: noop },
    dmIdentity: {
      selfPubkey: null,
      profiles: new Map(),
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
  return { ...base, ...overrides };
}

/**
 * Render `element` inside the providers the rail needs. Returns the
 * container, a re-render, and an unmount that also drops the query cache
 * (its GC timer would otherwise hold the test process open).
 */
export async function mountInRail(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const wrap = (child) =>
    React.createElement(QueryClientProvider, { client: queryClient }, child);
  await act(async () => root.render(wrap(element)));
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    rerender: async (next) => act(async () => root.render(wrap(next))),
    unmount: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
}

/** Rendered DM rows of one section, in order: `{ name, badge }`. */
export function sectionRows(container, label) {
  const section = container.querySelector(`section[aria-label="${label}"]`);
  if (!section) return [];
  return Array.from(section.querySelectorAll("ul > li")).flatMap((li) => {
    const button = li.querySelector("button[data-active]");
    if (!button) return [];
    const badge = button.querySelector('[data-testid="dm-row-badge"]');
    return [
      {
        name: button.querySelector("span.truncate")?.textContent ?? "",
        badge: badge === null ? null : badge.textContent,
      },
    ];
  });
}

/** The section's "N more" row text, or null. */
export function moreLabel(container, label) {
  const section = container.querySelector(`section[aria-label="${label}"]`);
  return (
    section?.querySelector('[data-testid="section-more"]')?.textContent ?? null
  );
}

/**
 * Rest the pointer on row `index` of a section (the per-row hold's
 * trigger), as a browser does: a bubbling pointerover on the row.
 * Returns the row's name.
 */
export async function pointerOnRow(container, label, index) {
  const section = container.querySelector(`section[aria-label="${label}"]`);
  const button = section.querySelectorAll("ul > li > button[data-active]")[
    index
  ];
  await act(async () => {
    button.dispatchEvent(
      new dom.window.MouseEvent("pointerover", { bubbles: true }),
    );
  });
  return button.querySelector("span.truncate")?.textContent ?? "";
}

/** The pointer leaves the nav entirely. */
export async function pointerOffNav(container) {
  const nav = container.querySelector("nav");
  await act(async () => {
    nav.dispatchEvent(
      new dom.window.MouseEvent("pointerout", {
        bubbles: true,
        relatedTarget: null,
      }),
    );
  });
}
