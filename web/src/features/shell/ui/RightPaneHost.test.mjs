import assert from "node:assert/strict";
import { after, test } from "node:test";

// RightPaneHost under jsdom + act, inside the real FileTabsProvider: the
// right pane's two top-level tabs (Work | Canvas, Sam 2026-09-30) and the
// documents UNDER Canvas. Heavy leaves are stubbed through the loader's
// module-stub seam — Work's feed, the thinking panel, the file previewer,
// the markdown renderer and the channel-canvas REQ — so what runs for real
// is the host, the Canvas pane, the provider and the pure models.
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
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
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

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
globalThis.__BUZZ_TEST_REACT__ = React;

/** What the stubbed channel-canvas hook answers; tests set it per case. */
globalThis.__CANVAS_TEST_STATE__ = { doc: null, phase: "idle" };

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/features/work/useWorkCounts.ts": `
    export function useWorkCounts() {
      return { needs: 2, running: 1, markers: new Map() };
    }
  `,
  // Stub sources cannot import "react" (no file URL to resolve from), so
  // they reach the test's React through a global.
  "@/features/work/ui/WorkTab": `
    export function WorkTab() {
      return globalThis.__BUZZ_TEST_REACT__.createElement(
        "aside",
        { "data-testid": "work-rail" },
        "Work feed",
      );
    }
  `,
  "@/features/agents/ui/AgentActivityPanel": `
    export function AgentActivityPanel() {
      return globalThis.__BUZZ_TEST_REACT__.createElement("div", {
        "data-testid": "thinking",
      });
    }
  `,
  "@/features/shelf/ui/FilePreview": `
    export function FilePreview({ file, variant }) {
      return globalThis.__BUZZ_TEST_REACT__.createElement(
        "section",
        { "data-testid": "file-preview", "data-variant": variant },
        file.filename,
      );
    }
  `,
  "@/features/channels/ui/MarkdownContent": `
    export function MarkdownContent({ content }) {
      return globalThis.__BUZZ_TEST_REACT__.createElement(
        "div",
        { "data-testid": "markdown" },
        content,
      );
    }
  `,
  "@/features/shelf/useShareNames.ts": `
    export function useShareNames() {
      return {
        person: () => "Lord Nikon",
        channel: () => "#general",
        isAgent: () => false,
        selfPubkey: null,
      };
    }
  `,
  "@/features/canvas/useChannelCanvas.ts": `
    export function useChannelCanvas(channelId) {
      return channelId === null
        ? { doc: null, phase: "idle" }
        : globalThis.__CANVAS_TEST_STATE__;
    }
  `,
};

const { FileTabsProvider, useFileTabs } = await import(
  "@/features/shelf/FileTabsProvider"
);
const { fileTabKey } = await import("@/features/shelf/lib/fileTabs.ts");
const { rightPaneLayout } = await import("../rightPaneLayout.ts");
const { RightPaneHost } = await import("./RightPaneHost.tsx");

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

const CHANNEL = "c3309d9d-3ee5-52c1-8309-e6738b177a19";

function openFile(filename) {
  const url = `https://relay.test/media/${filename}`;
  return {
    key: fileTabKey("m-1", url),
    url,
    filename,
    mime: filename.endsWith(".pdf") ? "application/pdf" : null,
    size: 1200,
    channelId: CHANNEL,
    messageId: "m-1",
    authorPubkey: "b".repeat(64),
    createdAt: 1_790_000_000,
    rootId: null,
    replyToId: null,
    path: null,
  };
}

async function mount({ channelId = CHANNEL } = {}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const selected = [];
  const api = { current: null };
  function Host() {
    api.current = useFileTabs();
    // A plain channel: the shell's own tabs are Work alone.
    const layout = rightPaneLayout({
      surface: "conversation",
      agentDm: false,
      active: "work",
      previous: "work",
      paneHidden: false,
      webLayer: "none",
      filesWorkOpen: false,
      workTab: true,
      workCollapsed: false,
    });
    return React.createElement(RightPaneHost, {
      layout,
      drag: {},
      dockWidth: 380,
      onSelectTab: (tab) => selected.push(tab),
      onCloseActivity: () => {},
      activity: null,
      activityChrome: {
        mobileOpen: false,
        onCloseMobile: () => {},
        onCloseDesktop: () => {},
      },
      work: {
        channelId,
        onOpenMessage: () => {},
        onOpenChannel: () => {},
        onOpenView: () => {},
        onCollapse: () => {},
        onExpand: () => {},
      },
    });
  }
  await act(async () => {
    root.render(
      React.createElement(
        FileTabsProvider,
        { onOpenMessage: () => {}, onOpenShelf: () => {} },
        React.createElement(Host),
      ),
    );
  });
  const q = (selector) => container.querySelector(selector);
  const qa = (selector) => [...container.querySelectorAll(selector)];
  return {
    api,
    selected,
    q,
    /** The top-level strip's tabs, by name. */
    topTabs: () =>
      qa('[data-testid="right-pane-tabs"] [role="tab"]').map((tab) =>
        tab.getAttribute("data-testid"),
      ),
    /** Canvas's own document tabs: [label, selected]. */
    docTabs: () =>
      qa('[data-testid="canvas-tabs"] [role="tab"]').map((tab) => [
        tab.textContent,
        tab.getAttribute("aria-selected") === "true",
      ]),
    onScreen: () =>
      q('[data-testid="right-pane-host"]').getAttribute("data-active-tab"),
    click: async (element) => {
      assert.ok(element, "the element to click exists");
      await act(async () => {
        element.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
    },
    run: async (fn) => {
      await act(async () => {
        fn(api.current);
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("an attachment opens UNDER Canvas: the strip stays exactly Work | Canvas", async () => {
  globalThis.__CANVAS_TEST_STATE__ = { doc: null, phase: "ready" };
  const pane = await mount();
  try {
    assert.deepEqual(pane.topTabs(), [
      "right-pane-tab-work",
      "right-pane-tab-canvas",
    ]);
    assert.equal(pane.onScreen(), "work");
    assert.ok(pane.q('[data-testid="work-rail"]'), "Work's own content");

    // A tile click in chat (useTileOpener → tabs.open).
    await pane.run((tabs) => tabs.open(openFile("capture-plan.pdf")));
    assert.equal(pane.onScreen(), "canvas", "the pane switched to Canvas");
    assert.deepEqual(
      pane.topTabs(),
      ["right-pane-tab-work", "right-pane-tab-canvas"],
      "the file is not a top-level tab",
    );
    assert.deepEqual(pane.docTabs(), [["capture-plan.pdf", true]]);
    assert.equal(
      pane.q('[data-testid="file-preview"]').textContent,
      "capture-plan.pdf",
    );
    assert.equal(pane.q('[data-testid="work-rail"]'), null);
    assert.equal(pane.q('[data-testid="canvas-count"]').textContent, "1");

    // A second attachment joins it under Canvas and is selected.
    await pane.run((tabs) => tabs.open(openFile("notes.md")));
    assert.equal(pane.topTabs().length, 2);
    assert.deepEqual(pane.docTabs(), [
      ["capture-plan.pdf", false],
      ["notes.md", true],
    ]);

    // Work is unchanged and one click away; Canvas comes back to notes.md.
    await pane.click(pane.q('[data-testid="right-pane-tab-work"]'));
    assert.equal(pane.onScreen(), "work");
    assert.ok(pane.q('[data-testid="work-rail"]'));
    assert.equal(pane.q('[data-testid="canvas-tabs"]'), null);
    assert.deepEqual(pane.selected, ["work"]);
    await pane.click(pane.q('[data-testid="right-pane-tab-canvas"]'));
    assert.equal(pane.onScreen(), "canvas");
    assert.deepEqual(pane.docTabs(), [
      ["capture-plan.pdf", false],
      ["notes.md", true],
    ]);

    // Each document closes from its own sub-tab; the last hands back Work.
    await pane.click(pane.q('[aria-label="Close notes.md"]'));
    assert.deepEqual(pane.docTabs(), [["capture-plan.pdf", true]]);
    await pane.click(pane.q('[aria-label="Close capture-plan.pdf"]'));
    assert.equal(pane.onScreen(), "work");
    assert.ok(pane.q('[data-testid="work-rail"]'));
  } finally {
    await pane.unmount();
  }
});

test("the channel canvas is pinned first under Canvas and cannot be closed", async () => {
  globalThis.__CANVAS_TEST_STATE__ = {
    phase: "ready",
    doc: {
      eventId: "e".repeat(64),
      channelId: CHANNEL,
      content: "# Team Directory",
      authorPubkey: "b".repeat(64),
      updatedAt: 1_790_000_000,
    },
  };
  const pane = await mount();
  try {
    assert.equal(pane.q('[data-testid="canvas-count"]').textContent, "1");
    await pane.click(pane.q('[data-testid="right-pane-tab-canvas"]'));
    assert.deepEqual(pane.docTabs(), [["Channel canvas", true]]);
    assert.equal(
      pane.q('[data-testid="channel-canvas-title"]').textContent,
      "#general",
    );
    assert.equal(
      pane.q('[data-testid="markdown"]').textContent,
      "# Team Directory",
    );
    assert.equal(
      pane.q('[aria-label="Close Channel canvas"]'),
      null,
      "it follows the conversation; there is nothing to close",
    );

    // A file joins after it; closing the file lands back on the canvas.
    await pane.run((tabs) => tabs.open(openFile("report.pdf")));
    assert.deepEqual(pane.docTabs(), [
      ["Channel canvas", false],
      ["report.pdf", true],
    ]);
    await pane.click(pane.q('[aria-label="Close report.pdf"]'));
    assert.equal(pane.onScreen(), "canvas");
    assert.deepEqual(pane.docTabs(), [["Channel canvas", true]]);
  } finally {
    await pane.unmount();
  }
});

test("an empty Canvas says what lands there; no conversation means no channel canvas", async () => {
  globalThis.__CANVAS_TEST_STATE__ = {
    phase: "ready",
    doc: {
      eventId: "e".repeat(64),
      channelId: CHANNEL,
      content: "# Should not show on a view page",
      authorPubkey: "b".repeat(64),
      updatedAt: 1_790_000_000,
    },
  };
  const pane = await mount({ channelId: null });
  try {
    assert.equal(pane.q('[data-testid="canvas-count"]'), null);
    await pane.click(pane.q('[data-testid="right-pane-tab-canvas"]'));
    assert.equal(pane.onScreen(), "canvas");
    assert.ok(pane.q('[data-testid="canvas-empty"]'));
    assert.match(
      pane.q('[data-testid="canvas-empty"]').textContent,
      /Nothing on the canvas/,
    );
    assert.equal(pane.q('[data-testid="file-expand"]'), null);
  } finally {
    await pane.unmount();
  }
});

test("Work | Canvas are Shelf-style chips; the needs hex follows the chip", async () => {
  globalThis.__CANVAS_TEST_STATE__ = { doc: null, phase: "ready" };
  const pane = await mount();
  const chip = (tab) =>
    pane.q(`[data-testid="right-pane-tab-${tab}"]`).parentElement.className;
  const hex = () =>
    pane.q('[data-testid="work-needs-count"] .buzz-hex').className;
  try {
    // Work on screen: solid primary chip, white hex; Canvas a bordered card.
    assert.match(chip("work"), /\bbg-primary\b/);
    assert.match(chip("work"), /\btext-primary-foreground\b/);
    assert.match(chip("canvas"), /\bborder-border\b/);
    assert.match(chip("canvas"), /\bbg-card\b/);
    assert.doesNotMatch(chip("canvas"), /\bbg-primary\b/);
    assert.equal(
      pane.q('[data-testid="work-needs-count"]').textContent,
      "2",
      "the unread needs count stays",
    );
    assert.match(hex(), /\bbg-primary-foreground\b/);
    assert.doesNotMatch(hex(), /\bbg-need\b/, "no coral on the orange chip");

    // Canvas on screen: the chips swap; the hex turns primary on the card.
    await pane.run((tabs) => tabs.open(openFile("notes.md")));
    assert.match(chip("canvas"), /\bbg-primary\b/);
    assert.match(chip("work"), /\bbg-card\b/);
    assert.match(hex(), /\bbg-primary\b/);
    assert.doesNotMatch(hex(), /\bbg-primary-foreground\b/);
  } finally {
    await pane.unmount();
  }
});
