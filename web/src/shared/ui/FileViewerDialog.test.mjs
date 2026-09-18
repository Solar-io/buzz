import assert from "node:assert/strict";
import { test, after } from "node:test";

// FileViewerDialog under jsdom + act — the AgentPortraitOverlay pattern. The
// signed-media seam is stubbed at the module boundary so the dialog's
// relay-media path resolves deterministically; everything else is the real
// component tree (Radix dialog included).
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
};
// Hoist the jsdom window onto the global, global-jsdom style: every window
// property the global lacks becomes a getter, and the handful of names Node
// ships its own natives for (Event, Node, …) are FORCE-OVERridden with the
// jsdom versions — Radix's Presence/FocusScope/DismissableLayer construct
// events via the global, and jsdom nodes reject Node's native Event on
// dispatch. Snapshotting own keys lets `after` remove exactly what we added.
const globalKeysBefore = new Set(Object.getOwnPropertyNames(globalThis));
// Node natives that must lose to the jsdom constructors:
const FORCE_JSOM = new Set([
  "Event",
  "EventTarget",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "getComputedStyle",
]);
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "globalThis") {
    continue;
  }
  if (FORCE_JSOM.has(key) || !(key in globalThis)) {
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
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
globalThis.__BUZZ_TEST_REACT__ = React;

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
  // dialog.tsx's overlay reads the theme; a stub keeps the test focused on
  // the viewer instead of the theme stack (jsdom has no matchMedia). Stub
  // sources cannot use import statements (they resolve against a synthetic
  // URL), so React reaches them via a global set below.
  "@/shared/theme/ThemeProvider": `
    const React = globalThis.__BUZZ_TEST_REACT__;
    const ThemeContext = React.createContext({ isDark: false });
    export function ThemeProvider({ children }) {
      return React.createElement(
        ThemeContext.Provider,
        { value: { isDark: false } },
        children,
      );
    }
    export function useTheme() {
      return React.useContext(ThemeContext);
    }
    export const THEME_STORAGE_KEY = "buzz-theme";
    export const FOLLOW_SYSTEM_STORAGE_KEY = "buzz-follow-system";
    export const ACCENT_STORAGE_KEY = "buzz-accent-color";
  `,
};

const { FileViewerProvider, useFileViewer } = await import(
  "./FileViewerDialog.tsx"
);

const RELAY = "https://crichton.tailb3d4b8.ts.net:6351";
const MEDIA_URL = `${RELAY}/media/${"a".repeat(64)}.png`;

// No JSX in .mjs tests (the loader only transpiles .tsx) — createElement only.
function Probe({ url }) {
  const openViewer = useFileViewer();
  return React.createElement(
    "button",
    {
      type: "button",
      "data-testid": "probe-open",
      onClick: () => openViewer?.(url),
    },
    "open",
  );
}

async function mountViewer(url) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        FileViewerProvider,
        { relayBase: RELAY },
        React.createElement(Probe, { url }),
      ),
    );
  });
  return {
    container,
    open: async () => {
      const button = container.querySelector('[data-testid="probe-open"]');
      await act(async () => {
        button.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      await flush();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// Drain the signed-fetch promise chain: click → setState → dialog effect →
// fetch → setState(ready). Each act flush runs queued microtasks and effects.
async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

after(() => {
  // Remove exactly the keys this file added, then restore the manual hoists.
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (!globalKeysBefore.has(key)) {
      try {
        delete globalThis[key];
      } catch {
        // Non-configurable — leave it.
      }
    }
  }
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = originals.media;
});

test("relay media resolves through the signed-fetch seam and renders the object URL", async () => {
  const seen = [];
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async (url) => {
    seen.push(url);
    return "blob:mock-object-url";
  };
  const viewer = await mountViewer(MEDIA_URL);
  await viewer.open();

  // The seam is INVOKED with the relay media URL — invocation, not just
  // render, is the contract (a plain <img src> would get the relay's 401).
  assert.deepEqual(seen, [MEDIA_URL]);

  const body = dom.window.document.querySelector(
    '[data-testid="file-viewer-body"]',
  );
  assert.ok(body, "viewer body renders");
  const img = body.querySelector("img");
  assert.ok(img, "image kind renders an img");
  assert.equal(img.getAttribute("src"), "blob:mock-object-url");
  await viewer.unmount();
});

test("non-relay images render the raw URL and never touch the signed seam", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => {
    throw new Error("signed seam must not be used for non-relay URLs");
  };
  const viewer = await mountViewer("https://example.com/photos/cat.png");
  await viewer.open();

  const img = dom.window.document.querySelector(
    '[data-testid="file-viewer-body"] img',
  );
  assert.ok(img, "image renders");
  assert.equal(img.getAttribute("src"), "https://example.com/photos/cat.png");
  await viewer.unmount();
});

test("a failed signed fetch surfaces the inline error state", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => {
    throw new Error("401");
  };
  const viewer = await mountViewer(MEDIA_URL);
  await viewer.open();

  const error = dom.window.document.querySelector(
    '[data-testid="file-viewer-error"]',
  );
  assert.ok(error, "error state renders");
  assert.match(error.textContent ?? "", /relay store/);
  // The error panel keeps a download escape hatch.
  assert.ok(
    dom.window.document.querySelector('[data-testid="file-viewer-download"]'),
    "download action survives the failure",
  );
  await viewer.unmount();
});

test("pdf renders an iframe and unpreviewable files render the fallback without fetching", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => {
    throw new Error("signed seam must not be used for non-relay URLs");
  };
  const pdf = await mountViewer("https://example.com/report.pdf");
  await pdf.open();
  assert.ok(
    dom.window.document.querySelector('iframe[data-testid="file-viewer-body"]'),
    "pdf kind renders an iframe",
  );
  await pdf.unmount();

  const archive = await mountViewer("https://example.com/backup.zip");
  await archive.open();
  const body = dom.window.document.querySelector(
    '[data-testid="file-viewer-body"]',
  );
  assert.ok(body, "fallback body renders");
  assert.match(body.textContent ?? "", /No in-app preview/);
  assert.match(body.textContent ?? "", /backup\.zip/);
  await archive.unmount();
});

test("html viewer: relay edition pages get script access, strangers stay scriptless", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => {
    throw new Error("signed seam must not be used for non-relay URLs");
  };
  const RELAY = "https://crichton.tailb3d4b8.ts.net:6351";

  const ed = await mountViewer(`${RELAY}/edition/latest.html`);
  await ed.open();
  let frame = dom.window.document.querySelector('iframe[data-testid="file-viewer-body"]');
  assert.ok(frame, "edition renders the html iframe");
  assert.equal(
    frame.getAttribute("sandbox"),
    "allow-scripts",
    "our edition page runs its tab script in an opaque origin",
  );
  await ed.unmount();

  const foreign = await mountViewer("https://example.com/page.html");
  await foreign.open();
  frame = dom.window.document.querySelector('iframe[data-testid="file-viewer-body"]');
  assert.ok(frame, "foreign html renders the html iframe");
  assert.equal(
    frame.getAttribute("sandbox"),
    "allow-same-origin",
    "stranger html keeps the scriptless sandbox",
  );
  await foreign.unmount();
});
