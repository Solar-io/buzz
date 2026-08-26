import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

// `pretendToBeVisual` gives jsdom requestAnimationFrame; the drag resize path
// batches visual height updates through rAF and needs it to settle.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

let cleanup;
let createElement;
let fireEvent;
let render;
let waitFor;
let WebPanelSubstrate;
let WEB_PANELS;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  ({ cleanup, fireEvent, render, waitFor } = await import(
    "@testing-library/react"
  ));
  ({ createElement } = await import("react"));
  ({ WEB_PANELS } = await import("./webPanels.config.ts"));
  ({ WebPanelSubstrate } = await import("./WebPanelSubstrate.tsx"));
});

after(() => {
  cleanup?.();
  dom.window.close();
});

beforeEach(() => {
  cleanup?.();
  dom.window.localStorage.clear();
});

function fixture(props = {}) {
  const callbacks = { hide: 0, logins: 0, modeChanges: [] };
  const view = render(
    createElement(WebPanelSubstrate, {
      panel: WEB_PANELS[0],
      mode: "docked",
      visible: true,
      onHide: () => {
        callbacks.hide += 1;
      },
      onLogin: () => {
        callbacks.logins += 1;
      },
      onModeChange: (mode) => callbacks.modeChanges.push(mode),
      ...props,
    }),
  );
  return { callbacks, view };
}

test("renders the configured page in an unsandboxed iframe", () => {
  const { view } = fixture();
  const iframe = view.container.querySelector("iframe");
  assert.ok(iframe, "panel must host an iframe");
  assert.equal(iframe.getAttribute("src"), WEB_PANELS[0].url);
  assert.equal(iframe.getAttribute("title"), "Files");
  // The panel app needs cookies and downloads; a sandbox attribute would
  // break both. This pins that nobody "hardens" it back in.
  assert.equal(iframe.getAttribute("sandbox"), null);
});

test("header shows the panel label and window actions", () => {
  const { view } = fixture();
  assert.ok(view.getByText("Files"));
  assert.ok(view.getByLabelText("Log in to Files"));
  assert.ok(view.getByLabelText("Reload Files"));
  assert.ok(view.getByLabelText("Maximize Files panel"));
  assert.ok(view.getByLabelText("Hide Files panel"));
});

test("hide and login actions reach their handlers", () => {
  const { callbacks, view } = fixture();
  fireEvent.click(view.getByLabelText("Hide Files panel"));
  fireEvent.click(view.getByLabelText("Log in to Files"));
  assert.equal(callbacks.hide, 1);
  assert.equal(callbacks.logins, 1);
});

test("maximize toggles the rendered mode and the action labels", () => {
  const { callbacks, view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.dataset.webpanelMode, "docked");

  // Mode is parent-controlled (the store owns it), so the click reports the
  // transition and the label flips once the parent re-renders with the new
  // mode — exactly how the terminal substrate behaves.
  fireEvent.click(view.getByLabelText("Maximize Files panel"));
  assert.deepEqual(callbacks.modeChanges, ["maximized"]);
  view.rerender(
    createElement(WebPanelSubstrate, {
      panel: WEB_PANELS[0],
      mode: "maximized",
      onHide: () => {},
      onLogin: () => {},
      onModeChange: (mode) => callbacks.modeChanges.push(mode),
    }),
  );
  assert.equal(substrate.dataset.webpanelMode, "maximized");

  fireEvent.click(view.getByLabelText("Restore Files panel"));
  assert.deepEqual(callbacks.modeChanges, ["maximized", "docked"]);
});

test("maximized panels hide the resize handle", () => {
  const { view } = fixture({ mode: "maximized" });
  assert.ok(view.getByLabelText("Restore Files panel"));
  assert.throws(() => view.getByLabelText("Resize Files panel"));
});

test("dock height defaults to 320 and persists keyboard resizes", () => {
  const { view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.style.height, "320px");

  const handle = view.getByLabelText("Resize Files panel");
  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  assert.equal(substrate.style.height, "336px");
  assert.equal(window.localStorage.getItem("buzz-webpanel-dock-height"), "336");

  fireEvent.keyDown(handle, { key: "ArrowDown" });
  assert.equal(substrate.style.height, "320px");
  assert.equal(window.localStorage.getItem("buzz-webpanel-dock-height"), "320");
});

test("keyboard resize clamps to the 180px floor", () => {
  window.localStorage.setItem("buzz-webpanel-dock-height", "100");
  const { view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.style.height, "100px");

  const handle = view.getByLabelText("Resize Files panel");
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  // jsdom's viewport is 768px tall: 70% is 537.6, so the floor binds first.
  assert.equal(substrate.style.height, "180px");
  assert.equal(window.localStorage.getItem("buzz-webpanel-dock-height"), "180");
});

test("keyboard resize clamps to 70% of the viewport", () => {
  window.localStorage.setItem("buzz-webpanel-dock-height", "600");
  const { view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  const handle = view.getByLabelText("Resize Files panel");
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  // 70% of jsdom's 768px viewport, in IEEE-754: 537.5999999999999.
  assert.equal(substrate.style.height, "537.5999999999999px");
  assert.equal(window.localStorage.getItem("buzz-webpanel-dock-height"), "538");
});

test("persisted height is honored on mount", () => {
  window.localStorage.setItem("buzz-webpanel-dock-height", "410");
  const { view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.style.height, "410px");
});

test("drag resize commits only on release, under its own storage key", async () => {
  const { view } = fixture();
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  const handle = view.getByLabelText("Resize Files panel");

  fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
  assert.equal(substrate.dataset.webpanelResizing, "true");
  fireEvent.pointerMove(handle, { clientY: 440, pointerId: 1 });
  assert.equal(
    window.localStorage.getItem("buzz-webpanel-dock-height"),
    null,
    "drag must not persist before release",
  );
  await waitFor(() => assert.equal(substrate.style.height, "380px"));

  fireEvent.pointerUp(handle, { clientY: 440, pointerId: 1 });
  assert.equal(substrate.dataset.webpanelResizing, undefined);
  assert.equal(window.localStorage.getItem("buzz-webpanel-dock-height"), "380");
  // The terminal's persisted height must be untouched by web panel drags.
  assert.equal(window.localStorage.getItem("buzz-terminal-dock-height"), null);
});

test("reload remounts the iframe at the same url", () => {
  const { view } = fixture();
  const first = view.container.querySelector("iframe");
  fireEvent.click(view.getByLabelText("Reload Files"));
  const second = view.container.querySelector("iframe");
  assert.notEqual(first, second, "reload must remount the iframe");
  assert.equal(second.getAttribute("src"), WEB_PANELS[0].url);
  assert.equal(second.getAttribute("sandbox"), null);
});

test("closed panels keep their dom for the close transition", () => {
  const { view } = fixture({ visible: false });
  const substrate = view.container.querySelector(".buzz-webpanel-substrate");
  assert.equal(substrate.dataset.webpanelVisible, "false");
  assert.ok(view.getByLabelText("Reload Files"), "header stays mounted");
});
