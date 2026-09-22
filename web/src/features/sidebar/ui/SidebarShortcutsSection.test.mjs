import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The Links section's storage routing, driven through the real component.
 *
 * `localLinkStore.test.mjs` proves the store; this proves the SECTION:
 * it renders for a non-local signer (empty list included, + discoverable),
 * its add/remove go to localStorage there, and a local-key signer's add
 * still publishes the kind-30078 blob while leaving localStorage untouched.
 * "Renders for nobody but the local key" was the old contract — these cases
 * pin its replacement.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
// jsdom only prints "Not implemented: Window's open()". Silenced, not
// asserted: a menu-item click propagates through the portal boundary back to
// the row button's onClick (React's documented portal event behavior; the
// dropdown is rendered inside the row's JSX), so removing a WINDOW-mode link
// opens it too. Pre-existing SidebarNavButton composition, not this
// feature's contract.
dom.window.open = () => null;
// Node 26 ships its own `localStorage` on globalThis that evaluates to
// undefined without --localstorage-file. Remove it and pin jsdom's real
// storage so the fallback store reads and writes something observable.
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

const TOASTS = [];
globalThis.__BUZZ_TEST_TOASTS__ = TOASTS;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_RELAY_SESSION__ ?? null, status: "open" };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  // The signer seam the whole feature branches on. ownPubkey is null for the
  // extension signer (so no relay subscription is opened) and a fixed hex
  // key for the local one (the blob path's encrypt-to-self coordinate).
  "@/shared/lib/nostr-signer": `
    export function activeSignerSource() {
      return globalThis.__BUZZ_TEST_SIGNER_SOURCE__ ?? "local";
    }
    export async function ownPubkey() {
      return globalThis.__BUZZ_TEST_SIGNER_SOURCE__ === "extension"
        ? null
        : "ab".repeat(32);
    }
    export async function nip44EncryptTo(plaintext) {
      return { ciphertext: "stub:" + plaintext };
    }
    export async function nip44DecryptFrom(content) {
      return { plaintext: String(content).replace(/^stub:/, "") };
    }
    export async function signNostrEvent(event) {
      return { ...event, id: "e".repeat(64), sig: "f".repeat(64) };
    }
  `,
  "@/shared/lib/key-store": `
    export function subscribeAuth() { return () => {}; }
  `,
  // The dialog's overlay reads the theme for its scrim opacity, and useTheme
  // throws outside its provider (DecisionCard.test.mjs stubs it for the same
  // reason).
  "@/shared/theme/ThemeProvider": `
    export function useTheme() { return { isDark: true }; }
    export function ThemeProvider({ children }) { return children ?? null; }
  `,
  sonner: `
    export const toast = {
      error(...args) { globalThis.__BUZZ_TEST_TOASTS__.push(args[0]); },
    };
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { addSidebarShortcut } = await import(
  "@/features/shortcut-bar/lib/shortcutBlob.ts"
);
const { mutateLocalLinks } = await import(
  "@/features/shortcut-bar/lib/localLinkStore.ts"
);
const { SidebarShortcutsSection } = await import(
  "./SidebarShortcutsSection.tsx"
);

const LINKS_KEY = "buzz.links.v1";

/** A relay session that records publishes and answers ok. */
function installFakeSession() {
  const calls = [];
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = {
    calls,
    subscribe() {
      return () => {};
    },
    async publish(event) {
      calls.push(event);
      return { ok: true, message: "" };
    },
  };
  return calls;
}

async function mount() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const openedOverlays = [];
  await act(async () => {
    root.render(
      React.createElement(SidebarShortcutsSection, {
        onOpenOverlay: (id) => openedOverlays.push(id),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  const inBody = (selector) => dom.window.document.body.querySelector(selector);
  const inTree = (selector) => container.querySelectorAll(selector);
  const linksInStorage = () => {
    const raw = dom.window.localStorage.getItem(LINKS_KEY);
    return raw ? (JSON.parse(raw).shortcuts.__sidebar__ ?? []) : [];
  };
  return {
    container,
    openedOverlays,
    rows: () =>
      Array.from(inTree("button[data-active]")).map(
        (row) => row.textContent.replace("⋯", ""), // the overflow trigger's glyph
      ),
    addButton: () => inBody('button[aria-label="Add a link"]'),
    text: () => container.textContent,
    click: async (node, what) => {
      assert.ok(node, `${what} must exist to be clicked`);
      await act(async () => {
        node.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
    },
    keydown: async (node, key, what) => {
      assert.ok(node, `${what} must exist to be keyed`);
      await act(async () => {
        node.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key, bubbles: true }),
        );
      });
    },
    type: async (testid, value) => {
      const node =
        container.querySelector(`[data-testid="${testid}"]`) ??
        inBody(`[data-testid="${testid}"]`);
      assert.ok(node, `${testid} must exist to type into`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(node, value);
        node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    linksInStorage,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("an extension signer sees the Links section at all, empty list included", async () => {
  installFakeSession();
  globalThis.__BUZZ_TEST_SIGNER_SOURCE__ = "extension";
  dom.window.localStorage.clear();
  const view = await mount();
  try {
    assert.match(view.text(), /Links/, "the header renders");
    assert.ok(view.addButton(), "the + button renders on an empty list");
    assert.equal(view.rows().length, 0, "no rows for an empty list");
    assert.equal(
      dom.window.localStorage.getItem(LINKS_KEY),
      null,
      "mounting wrote nothing",
    );
  } finally {
    await view.unmount();
  }
});

test("an extension signer's add goes to localStorage, never the relay", async () => {
  const publishes = installFakeSession();
  globalThis.__BUZZ_TEST_SIGNER_SOURCE__ = "extension";
  dom.window.localStorage.clear();
  await mutateLocalLinks((blob) =>
    addSidebarShortcut(blob, {
      url: "https://kept.example/roadmap",
      label: "Roadmap",
      mode: "overlay",
    }),
  );
  const view = await mount();
  try {
    assert.deepEqual(
      view.rows(),
      ["Roadmap"],
      "the seeded local link renders as a row",
    );

    await view.click(view.addButton(), "the + button");
    const dialog = dom.window.document.body.querySelector(
      '[data-testid="shortcut-dialog"]',
    );
    assert.ok(dialog, "the add dialog opened");
    await view.type("shortcut-url", "https://status.example/");
    await view.type("shortcut-label", "Status");
    await view.click(
      dom.window.document.body.querySelector('[data-testid="shortcut-submit"]'),
      "the dialog's Add",
    );

    assert.deepEqual(
      view.linksInStorage().map((link) => link.label),
      ["Roadmap", "Status"],
      "the add persisted to localStorage",
    );
    assert.equal(view.rows().length, 2, "the row appeared without a reload");
    assert.equal(publishes.length, 0, "nothing was published");
    assert.equal(TOASTS.length, 0, "and nothing errored");
  } finally {
    await view.unmount();
  }
});

test("an extension signer's remove goes through the row menu to localStorage", async () => {
  installFakeSession();
  globalThis.__BUZZ_TEST_SIGNER_SOURCE__ = "extension";
  dom.window.localStorage.clear();
  await mutateLocalLinks((blob) =>
    addSidebarShortcut(blob, {
      url: "https://kept.example/roadmap",
      label: "Roadmap",
    }),
  );
  const view = await mount();
  try {
    // The ⋯ overflow is the dropdown's trigger; ArrowDown is Radix's
    // keyboard open path (a plain click on the span would also toggle it).
    const trigger = view.container.querySelector(
      'span[role="button"][aria-label="Options for Roadmap"]',
    );
    await view.keydown(trigger, "ArrowDown", "the row's ⋯ trigger");
    const remove = Array.from(
      dom.window.document.body.querySelectorAll('[role="menuitem"]'),
    ).find((item) => item.textContent === "Remove");
    assert.ok(remove, "the row menu opened with Remove");
    await view.click(remove, "the Remove item");

    assert.deepEqual(view.linksInStorage(), [], "the removal persisted");
    assert.equal(view.rows().length, 0, "the row is gone");
  } finally {
    await view.unmount();
  }
});

test("a local-key signer's add publishes the blob and does NOT write localStorage", async () => {
  const publishes = installFakeSession();
  globalThis.__BUZZ_TEST_SIGNER_SOURCE__ = "local";
  dom.window.localStorage.clear();
  const view = await mount();
  try {
    assert.ok(view.addButton(), "the + button renders");
    await view.click(view.addButton(), "the + button");
    await view.type("shortcut-url", "https://kept.example/board");
    await view.type("shortcut-label", "Board");
    await view.click(
      dom.window.document.body.querySelector('[data-testid="shortcut-submit"]'),
      "the dialog's Add",
    );

    assert.equal(publishes.length, 1, "the add published one event");
    assert.equal(publishes[0].kind, 30078, "the shortcut-bar event kind");
    assert.ok(
      publishes[0].tags.some(
        (tag) => tag[0] === "d" && tag[1] === "shortcut-bar",
      ),
      "on the pinned d coordinate",
    );
    assert.match(
      publishes[0].content,
      /^stub:/,
      "the content is the NIP-44 ciphertext from the signer seam",
    );
    assert.equal(
      dom.window.localStorage.getItem(LINKS_KEY),
      null,
      "local-key mode never touches localStorage",
    );
    assert.deepEqual(
      view.rows(),
      ["Board"],
      "the optimistic overlay shows the row",
    );
  } finally {
    await view.unmount();
  }
});
