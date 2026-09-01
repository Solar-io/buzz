import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

const invokes = [];
// Substrate rendering does not depend on geometry (no patched gBCR: the
// placeholder reports a zero box and the native loop stays quiet — invoke
// assertions here are about explicit actions only).

let responses = {};
let _act;
let cleanup;
let createElement;
let fireEvent;
let render;
let waitFor;
let React;
let WebPanelSubstrate;
let WEB_PANELS;
let registry;

function respond(command, response) {
  responses[command] = response;
}

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      invokes.push([command, args]);
      const response = responses[command];
      return Promise.resolve(
        typeof response === "function" ? response() : (response ?? null),
      );
    },
  };
  ({ _act, cleanup, fireEvent, render, waitFor } = await import(
    "@testing-library/react"
  ));
  ({ createElement, default: React } = await import("react"));
  ({ WEB_PANELS } = await import("./webPanels.config.ts"));
  registry = await import("./webPanelRegistry.ts");
  ({ WebPanelSubstrate } = await import("./WebPanelSubstrate.tsx"));
});

after(() => {
  cleanup?.();
  dom.window.close();
});

beforeEach(() => {
  cleanup?.();
  invokes.length = 0;
  responses = {};
  registry.resetWebPanelRegistryForTests();
  dom.window.localStorage.clear();
});

function tab(overrides = {}) {
  return {
    instanceId: "files-1",
    panel: WEB_PANELS[0],
    height: null,
    active: true,
    ...overrides,
  };
}

// The substrate is parent-controlled for heights (the store owns them, so
// they persist per tab). The harness mirrors that contract: a height commit
// updates the tab and re-renders, exactly like webPanelStore does.
function Harness({ callbacks, initialTabs, ...props }) {
  const [tabs, setTabs] = React.useState(initialTabs);
  const setHeight = (instanceId, height) => {
    callbacks.heights.push([instanceId, height]);
    setTabs((current) =>
      current.map((entry) =>
        entry.instanceId === instanceId ? { ...entry, height } : entry,
      ),
    );
  };
  return createElement(WebPanelSubstrate, {
    tabs,
    panelTypes: WEB_PANELS,
    mode: "docked",
    visible: true,
    ...props,
    onHeightCommit: setHeight,
  });
}

function fixture(props = {}) {
  const callbacks = {
    closes: [],
    heights: [],
    hide: 0,
    instances: [],
    logins: [],
    selects: [],
    modeChanges: [],
  };
  const { tabs: initialTabs = [tab()], ...rest } = props;
  const view = render(
    createElement(Harness, {
      callbacks,
      initialTabs,
      ...rest,
      onHide: () => {
        callbacks.hide += 1;
      },
      onLogin: (panelId) => callbacks.logins.push(panelId),
      onModeChange: (mode) => callbacks.modeChanges.push(mode),
      onSelectTab: (instanceId) => callbacks.selects.push(instanceId),
      onCloseTab: (instanceId) => callbacks.closes.push(instanceId),
      onOpenInstance: (panelId) => callbacks.instances.push(panelId),
    }),
  );
  return { callbacks, view };
}

// ── Header + tab strip ──────────────────────────────────────────────────

test("native mode renders a placeholder, never an iframe", () => {
  const { view } = fixture();
  assert.equal(view.container.querySelector("iframe"), null);
  const placeholder = view.container.querySelector(
    ".buzz-webpanel-native-placeholder",
  );
  assert.ok(placeholder, "native mode must keep a placeholder div");
  assert.equal(
    placeholder.getAttribute("data-webpanel-placeholder"),
    "files-1",
  );
  assert.equal(
    view.container
      .querySelector(".buzz-webpanel-substrate")
      .getAttribute("data-webpanel-render"),
    "native",
  );
});

test("iframe fallback renders the configured page unsandboxed for the active tab", () => {
  const iframePanel = { ...WEB_PANELS[0], render: "iframe" };
  const { view } = fixture({ tabs: [tab({ panel: iframePanel })] });
  const iframe = view.container.querySelector("iframe");
  assert.ok(iframe, "fallback mode must host an iframe");
  assert.equal(iframe.getAttribute("src"), WEB_PANELS[0].url);
  assert.equal(iframe.getAttribute("title"), "Files");
  assert.equal(iframe.getAttribute("data-inactive"), "false");
  // The panel app needs cookies and downloads; a sandbox attribute would
  // break both. This pins that nobody "hardens" it back in.
  assert.equal(iframe.getAttribute("sandbox"), null);
});

test("the tab strip lists tabs with close affordances and an add button", () => {
  const { view } = fixture({
    tabs: [tab(), tab({ instanceId: "files-2", active: false })],
  });
  const tabs = view.container.querySelectorAll('[role="tab"]');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].getAttribute("aria-selected"), "false");
  assert.equal(view.getAllByLabelText("Close Files tab").length, 2);
  assert.ok(view.getByLabelText("Open a new panel tab"));
});

test("tab select and close clicks reach their handlers", () => {
  const { callbacks, view } = fixture({
    tabs: [tab(), tab({ instanceId: "files-2", active: false })],
  });
  fireEvent.click(view.getAllByRole("tab")[1]);
  assert.deepEqual(callbacks.selects, ["files-2"]);
  fireEvent.click(view.getAllByLabelText("Close Files tab")[1]);
  assert.deepEqual(callbacks.closes, ["files-2"]);
});

test("the add-tab picker lists configured panel types and opens one", () => {
  const { callbacks, view } = fixture();
  fireEvent.click(view.getByLabelText("Open a new panel tab"));
  const menu = view.container.querySelector('[role="menu"]');
  assert.ok(menu, "picker must open as a menu");
  // Static rows plus the owner-add entry; the static row opens its panel.
  assert.ok(view.getByRole("menuitem", { name: "Files" }));
  assert.ok(view.getByRole("menuitem", { name: "Add site…" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Files" }));
  assert.deepEqual(callbacks.instances, ["files"]);
  assert.equal(
    view.container.querySelectorAll('[role="menu"]').length,
    0,
    "picker closes after choosing",
  );
});

test("header actions fire: hide, login, maximize/restore", () => {
  const { callbacks, view } = fixture();
  fireEvent.click(view.getByLabelText("Hide web panels"));
  fireEvent.click(view.getByLabelText("Log in to Files"));
  fireEvent.click(view.getByLabelText("Maximize panel"));
  assert.equal(callbacks.hide, 1);
  assert.deepEqual(callbacks.logins, ["files"]);
  assert.deepEqual(callbacks.modeChanges, ["maximized"]);
  view.rerender(
    createElement(WebPanelSubstrate, {
      tabs: [tab()],
      panelTypes: WEB_PANELS,
      mode: "maximized",
      onHide: () => {},
      onLogin: () => {},
      onModeChange: (mode) => callbacks.modeChanges.push(mode),
    }),
  );
  fireEvent.click(view.getByLabelText("Restore panel"));
  assert.deepEqual(callbacks.modeChanges, ["maximized", "docked"]);
});

// ── Render modes ────────────────────────────────────────────────────────

test("iframe fallback keeps inactive tabs mounted but hidden", () => {
  const iframePanel = { ...WEB_PANELS[0], render: "iframe" };
  const { view } = fixture({
    tabs: [
      tab({ panel: iframePanel }),
      tab({ instanceId: "files-2", panel: iframePanel, active: false }),
    ],
  });
  const frames = view.container.querySelectorAll("iframe");
  assert.equal(frames.length, 2, "every tab stays mounted for keep-alive");
  assert.equal(frames[0].getAttribute("data-inactive"), "false");
  assert.equal(frames[1].getAttribute("data-inactive"), "true");
  assert.equal(frames[1].getAttribute("src"), WEB_PANELS[0].url);
});

test("native mode renders exactly one placeholder regardless of tab count", () => {
  const { view } = fixture({
    tabs: [tab(), tab({ instanceId: "files-2", active: false })],
  });
  assert.equal(
    view.container.querySelectorAll(".buzz-webpanel-native-placeholder").length,
    1,
    "inactive native tabs are hidden webviews, not extra placeholders",
  );
});

test("reload in iframe mode remounts only the active tab", () => {
  const iframePanel = { ...WEB_PANELS[0], render: "iframe" };
  const { view } = fixture({
    tabs: [
      tab({ panel: iframePanel }),
      tab({ instanceId: "files-2", panel: iframePanel, active: false }),
    ],
  });
  const first = view.container.querySelectorAll("iframe")[0];
  fireEvent.click(view.getByLabelText("Reload Files"));
  const after = view.container.querySelectorAll("iframe");
  assert.notEqual(after[0], first, "active tab must remount");
  assert.equal(
    view.container.querySelectorAll("iframe")[1],
    after[1],
    "inactive tab must not remount",
  );
  assert.equal(after[0].getAttribute("src"), WEB_PANELS[0].url);
  assert.equal(after[0].getAttribute("sandbox"), null);
});

test("reload in native mode reloads in place over IPC", () => {
  const { view } = fixture();
  fireEvent.click(view.getByLabelText("Reload Files"));
  return waitFor(() => {
    assert.deepEqual(invokes, [
      ["reload_web_panel", { instanceId: "files-1", panelId: "files" }],
    ]);
  });
});

// ── Dock height ─────────────────────────────────────────────────────────

test("dock height defaults to 320 and keyboard resizes commit to the active tab", () => {
  const { callbacks, view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.style.height, "320px");

  const handle = view.getByLabelText("Resize Files panel");
  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  assert.equal(substrate.style.height, "336px");
  assert.deepEqual(callbacks.heights, [["files-1", 336]]);

  fireEvent.keyDown(handle, { key: "ArrowDown" });
  assert.equal(substrate.style.height, "320px");
  assert.deepEqual(callbacks.heights, [
    ["files-1", 336],
    ["files-1", 320],
  ]);
});

test("each tab shows its own persisted height when activated", () => {
  // Two docks whose active tab differs: the displayed height follows the
  // active tab, not a dock-global value.
  const first = fixture({
    tabs: [
      tab({ height: 410 }),
      tab({ instanceId: "files-2", height: 260, active: false }),
    ],
  });
  const firstSubstrate = first.view.container.querySelector(
    ".buzz-webpanel-substrate",
  );
  assert.equal(firstSubstrate.style.height, "410px");

  const second = fixture({
    tabs: [
      tab({ height: 410, active: false }),
      tab({ instanceId: "files-2", height: 260, active: true }),
    ],
  });
  const secondSubstrate = second.view.container.querySelector(
    ".buzz-webpanel-substrate",
  );
  assert.equal(secondSubstrate.style.height, "260px");
});

test("keyboard resize clamps to the 180px floor and 70% ceiling", () => {
  const low = fixture({ tabs: [tab({ height: 100 })] });
  const lowHandle = low.view.container.querySelector(
    ".buzz-webpanel-resize-handle",
  );
  const lowSubstrate = low.view.container.querySelector(
    ".buzz-webpanel-substrate",
  );
  fireEvent.keyDown(lowHandle, { key: "ArrowDown" });
  // jsdom's viewport is 768px tall: 70% is 537.6, so the floor binds first.
  assert.equal(lowSubstrate.style.height, "180px");

  const high = fixture({ tabs: [tab({ height: 600 })] });
  const highHandle = high.view.container.querySelector(
    ".buzz-webpanel-resize-handle",
  );
  const highSubstrate = high.view.container.querySelector(
    ".buzz-webpanel-substrate",
  );
  fireEvent.keyDown(highHandle, { key: "ArrowUp" });
  // 70% of jsdom's 768px viewport, in IEEE-754: 537.5999999999999. The
  // store rounds the persisted value; the live display keeps the fraction.
  assert.equal(highSubstrate.style.height, "537.5999999999999px");
  assert.deepEqual(high.callbacks.heights, [["files-1", 537.5999999999999]]);
});

test("drag resize previews live and commits once on release", async () => {
  const { callbacks, view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  const handle = view.getByLabelText("Resize Files panel");

  fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
  assert.equal(substrate.dataset.webpanelResizing, "true");
  fireEvent.pointerMove(handle, { clientY: 440, pointerId: 1 });
  await waitFor(() => assert.equal(substrate.style.height, "380px"));
  assert.deepEqual(
    callbacks.heights,
    [],
    "drag must not commit before release",
  );

  fireEvent.pointerUp(handle, { clientY: 440, pointerId: 1 });
  assert.equal(substrate.dataset.webpanelResizing, undefined);
  assert.deepEqual(callbacks.heights, [["files-1", 380]]);
});

test("maximized dock ignores per-tab height and hides the resize handle", () => {
  const { view } = fixture({ mode: "maximized", tabs: [tab({ height: 410 })] });
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.style.height, "");
  assert.equal(
    view.container.querySelectorAll(".buzz-webpanel-resize-handle").length,
    0,
  );
});

test("closed docks keep their dom with tabs for the close transition", () => {
  const { view } = fixture({ visible: false });
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.dataset.webpanelVisible, "false");
  assert.equal(view.container.querySelectorAll('[role="tab"]').length, 1);
});

// ── Custom sites (owner-added) ──────────────────────────────────────────

test("picker rows for customs carry a remove affordance and open on click", () => {
  const docs = {
    id: "site-1",
    label: "Docs",
    title: "Docs",
    icon: WEB_PANELS[0].icon,
    url: null,
    render: "native",
    custom: true,
  };
  const { callbacks, view } = fixture({ panelTypes: [WEB_PANELS[0], docs] });
  fireEvent.click(view.getByLabelText("Open a new panel tab"));
  const items = view.getAllByRole("menuitem");
  assert.equal(items.length, 3, "Files, Docs, and Add site…");
  // The remove affordance exists for the custom row only.
  assert.ok(view.getByLabelText("Remove site Docs"));
  assert.equal(
    view.container.querySelectorAll('[aria-label="Remove site Files"]').length,
    0,
    "static rows never get a remove button",
  );
  fireEvent.click(view.getByRole("menuitem", { name: "Docs" }));
  assert.deepEqual(callbacks.instances, ["site-1"]);
  assert.equal(view.container.querySelectorAll('[role="menu"]').length, 0);
});

test("remove flow: a removed site's open tabs close through the store path", async () => {
  const docs = {
    id: "site-1",
    label: "Docs",
    title: "Docs",
    icon: WEB_PANELS[0].icon,
    url: null,
    render: "native",
    custom: true,
  };
  const callbacks = {
    closes: [],
    heights: [],
    hide: 0,
    instances: [],
    logins: [],
    selects: [],
    modeChanges: [],
  };
  const tabs = [
    tab(),
    {
      instanceId: "site-1-1",
      panel: docs,
      height: null,
      active: false,
    },
  ];
  // remove_custom_panel succeeds; the refreshed list no longer has site-1.
  respond("list_custom_panels", []);
  const view = render(
    createElement(WebPanelSubstrate, {
      tabs,
      panelTypes: [WEB_PANELS[0], docs],
      mode: "docked",
      visible: true,
      onHide: () => {},
      onLogin: () => {},
      onModeChange: () => {},
      onSelectTab: (instanceId) => callbacks.selects.push(instanceId),
      onCloseTab: (instanceId) => callbacks.closes.push(instanceId),
      onOpenInstance: (panelId) => callbacks.instances.push(panelId),
      onHeightCommit: () => {},
    }),
  );
  fireEvent.click(view.getByLabelText("Open a new panel tab"));
  fireEvent.click(view.getByLabelText("Remove site Docs"));
  await waitFor(() => {
    assert.deepEqual(callbacks.closes, ["site-1-1"]);
  });
  assert.deepEqual(invokes[0], ["remove_custom_panel", { id: "site-1" }]);
  assert.deepEqual(invokes[1], ["list_custom_panels", {}]);
});

test("add flow: the picker opens the trusted add window; the Rust event opens the tab", async () => {
  const callbacks = {
    closes: [],
    heights: [],
    hide: 0,
    instances: [],
    logins: [],
    selects: [],
    modeChanges: [],
  };
  // The add window's typed form lives in Rust-owned chrome; from here the
  // flow is (1) invoke open_web_panel_add_window, (2) Rust persists and
  // broadcasts custom-panel-added, which the registry channel delivers.
  respond("list_custom_panels", [
    { id: "site-2", label: "Wiki", title: "Wiki" },
  ]);
  let deliverAdded = null;
  registry.setCustomPanelAddedInstallerForTests(async (handler) => {
    deliverAdded = handler;
    return () => {};
  });
  const view = render(
    createElement(WebPanelSubstrate, {
      tabs: [tab()],
      panelTypes: [WEB_PANELS[0]],
      mode: "docked",
      visible: true,
      onHide: () => {},
      onLogin: () => {},
      onModeChange: () => {},
      onSelectTab: () => {},
      onCloseTab: () => {},
      onOpenInstance: (panelId) => callbacks.instances.push(panelId),
      onHeightCommit: () => {},
    }),
  );
  fireEvent.click(view.getByLabelText("Open a new panel tab"));
  fireEvent.click(view.getByRole("menuitem", { name: "Add site…" }));
  await waitFor(() => {
    assert.deepEqual(invokes, [["open_web_panel_add_window", {}]]);
  });
  assert.ok(deliverAdded, "mounting must install the added-event channel");
  deliverAdded({ id: "site-2", label: "Wiki", title: "Wiki" });
  await waitFor(() => {
    assert.deepEqual(callbacks.instances, ["site-2"]);
  });
});

test("custom tabs render the native placeholder and nav controls, never a frame", () => {
  // The registry's toDef shape: url never crosses the IPC boundary, so a
  // custom site is render:"native" by construction — even in e2e builds
  // (the iframe force applies to configured panels only). The substrate
  // must host it through the native placeholder path, never an iframe.
  const custom = {
    id: "site-1",
    label: "Docs",
    title: "Docs",
    icon: WEB_PANELS[0].icon,
    url: null,
    render: "native",
    custom: true,
  };
  const { view } = fixture({
    tabs: [tab({ panel: custom })],
  });
  assert.equal(view.container.querySelectorAll("iframe").length, 0);
  const placeholder = view.container.querySelector(
    ".buzz-webpanel-native-placeholder",
  );
  assert.ok(placeholder, "custom tabs render through the native placeholder");
  assert.equal(
    placeholder.getAttribute("data-webpanel-placeholder"),
    "files-1",
  );
  // Nav controls ride the native path for customs.
  assert.ok(view.getByLabelText("Go back in Docs"));
  assert.ok(view.getByLabelText("Go forward in Docs"));
  assert.ok(view.getByLabelText("Open Docs home"));
});

test("native-mode header carries back/forward/home beside reload", () => {
  const { view } = fixture();
  assert.ok(view.getByLabelText("Go back in Files"));
  assert.ok(view.getByLabelText("Go forward in Files"));
  assert.ok(view.getByLabelText("Open Files home"));
  assert.ok(view.getByLabelText("Reload Files"));
});

test("back/forward/home dispatch id-only invokes for the active tab", () => {
  const { view } = fixture({
    tabs: [tab(), tab({ instanceId: "files-2", active: false })],
  });
  fireEvent.click(view.getByLabelText("Go back in Files"));
  fireEvent.click(view.getByLabelText("Go forward in Files"));
  fireEvent.click(view.getByLabelText("Open Files home"));
  return waitFor(() => {
    assert.deepEqual(invokes, [
      ["web_panel_back", { instanceId: "files-1", panelId: "files" }],
      ["web_panel_forward", { instanceId: "files-1", panelId: "files" }],
      ["web_panel_home", { instanceId: "files-1", panelId: "files" }],
    ]);
  });
});

test("iframe fallback keeps reload only — no back/forward/home", () => {
  const iframePanel = { ...WEB_PANELS[0], render: "iframe" };
  const { view } = fixture({ tabs: [tab({ panel: iframePanel })] });
  assert.ok(view.getByLabelText("Reload Files"));
  assert.equal(
    view.container.querySelectorAll('[aria-label^="Go back in"]').length,
    0,
  );
  assert.equal(
    view.container.querySelectorAll('[aria-label^="Go forward in"]').length,
    0,
  );
  assert.equal(
    view.container.querySelectorAll('[aria-label$="home"]').length,
    0,
  );
});
