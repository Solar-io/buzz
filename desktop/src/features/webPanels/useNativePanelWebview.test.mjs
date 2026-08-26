import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

const invokes = [];
// Fixture rect the placeholder reports; tests move it to prove the loop
// tracks changes.
let fixtureRect = { x: 0, y: 300, width: 800, height: 320 };

let _act;
let cleanup;
let createElement;
let render;
let waitFor;
let useNativePanelWebview;
let readPlaceholderRect;
let rectKey;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => {
    const box = { ...fixtureRect, left: fixtureRect.x, top: fixtureRect.y };
    return box;
  };
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      invokes.push([command, args]);
      return Promise.resolve(null);
    },
  };
  ({ _act, cleanup, render, waitFor } = await import("@testing-library/react"));
  ({ createElement } = await import("react"));
  ({ useNativePanelWebview, readPlaceholderRect, rectKey } = await import(
    "./useNativePanelWebview.ts"
  ));
});

after(() => {
  cleanup?.();
  dom.window.close();
});

beforeEach(() => {
  cleanup?.();
  invokes.length = 0;
  fixtureRect = { x: 0, y: 300, width: 800, height: 320 };
});

function Harness({ enabled, instanceId, panelId }) {
  const ref = React.useRef(null);
  useNativePanelWebview({ enabled, instanceId, panelId, viewportRef: ref });
  return createElement("div", { ref });
}

let React;

before(async () => {
  ({ default: React } = await import("react"));
});

test("readPlaceholderRect rounds to whole logical px and drops collapsed boxes", () => {
  fixtureRect = { x: 12.4, y: 340.6, width: 799.7, height: 320.2 };
  assert.deepEqual(
    readPlaceholderRect({
      getBoundingClientRect: () => ({ ...fixtureRect }),
    }),
    {
      x: 12,
      y: 341,
      width: 800,
      height: 320,
    },
  );
  // Collapsed (dock opening/closed) must report nothing to pin.
  assert.equal(
    readPlaceholderRect({
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        width: 800,
        height: 0,
      }),
    }),
    null,
  );
  assert.equal(readPlaceholderRect(null), null);
});

test("rectKey discriminates rects", () => {
  assert.notEqual(
    rectKey({ x: 0, y: 300, width: 800, height: 320 }),
    rectKey({ x: 0, y: 299, width: 800, height: 320 }),
  );
});

test("an enabled hook invokes ensure with the placeholder rect", async () => {
  render(
    createElement(Harness, {
      enabled: true,
      instanceId: "files-1",
      panelId: "files",
    }),
  );
  await waitFor(() => assert.equal(invokes.length, 1));
  assert.deepEqual(invokes[0], [
    "ensure_web_panel",
    {
      instanceId: "files-1",
      panelId: "files",
      x: 0,
      y: 300,
      width: 800,
      height: 320,
    },
  ]);
});

test("rect changes are tracked and unchanged frames stay silent", async () => {
  render(
    createElement(Harness, {
      enabled: true,
      instanceId: "files-1",
      panelId: "files",
    }),
  );
  await waitFor(() => assert.equal(invokes.length, 1));
  // Give the loop several frames with the same rect: no duplicate invokes.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(invokes.length, 1, "unchanged rect must not re-invoke");
  // Move the placeholder (dock resize): the next frame syncs it.
  fixtureRect = { x: 0, y: 280, width: 800, height: 340 };
  await waitFor(() => assert.equal(invokes.length, 2));
  assert.deepEqual(invokes[1], [
    "ensure_web_panel",
    {
      instanceId: "files-1",
      panelId: "files",
      x: 0,
      y: 280,
      width: 800,
      height: 340,
    },
  ]);
});

test("a disabled hook never invokes and unmount hides the webview", async () => {
  const view = render(
    createElement(Harness, {
      enabled: false,
      instanceId: "files-1",
      panelId: "files",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(invokes.length, 0, "disabled hook must not invoke");

  view.rerender(
    createElement(Harness, {
      enabled: true,
      instanceId: "files-1",
      panelId: "files",
    }),
  );
  await waitFor(() => assert.ok(invokes.length >= 1));
  // Unmount (or disable) hides rather than destroys: keep-alive semantics.
  view.rerender(
    createElement(Harness, {
      enabled: false,
      instanceId: "files-1",
      panelId: "files",
    }),
  );
  await waitFor(() =>
    assert.deepEqual(invokes.at(-1), [
      "set_web_panel_visible",
      { instanceId: "files-1", panelId: "files", visible: false },
    ]),
  );
});

test("switching instances hides the old one and ensures the new one", async () => {
  const view = render(
    createElement(Harness, {
      enabled: true,
      instanceId: "files-1",
      panelId: "files",
    }),
  );
  await waitFor(() => assert.equal(invokes.length, 1));
  view.rerender(
    createElement(Harness, {
      enabled: true,
      instanceId: "files-2",
      panelId: "files",
    }),
  );
  await waitFor(() => assert.equal(invokes.length, 3));
  assert.deepEqual(invokes[1], [
    "set_web_panel_visible",
    { instanceId: "files-1", panelId: "files", visible: false },
  ]);
  assert.deepEqual(invokes[2], [
    "ensure_web_panel",
    {
      instanceId: "files-2",
      panelId: "files",
      x: 0,
      y: 300,
      width: 800,
      height: 320,
    },
  ]);
});
