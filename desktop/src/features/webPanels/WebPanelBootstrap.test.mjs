import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

const invokes = [];

let act;
let cleanup;
let createElement;
let fireEvent;
let render;
let waitFor;
let WebPanelBootstrap;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      invokes.push([command, args]);
      return Promise.resolve(null);
    },
  };
  ({ act, cleanup, fireEvent, render, waitFor } = await import(
    "@testing-library/react"
  ));
  ({ createElement } = await import("react"));
  ({ WebPanelBootstrap } = await import("./WebPanelBootstrap.tsx"));
});

after(() => {
  cleanup?.();
  dom.window.close();
});

beforeEach(() => {
  cleanup?.();
  invokes.length = 0;
});

test("login button sends only the panel id across the IPC boundary", async () => {
  const { toggleWebPanel, resetWebPanelForTests } = await import(
    "./webPanelStore.ts"
  );
  resetWebPanelForTests();
  const view = render(createElement(WebPanelBootstrap));
  await act(async () => {
    toggleWebPanel("files");
  });
  const login = await waitFor(() => {
    const button = view.getByLabelText("Log in to Files");
    assert.ok(button, "login button must mount with the open panel");
    return button;
  });

  fireEvent.click(login);

  assert.deepEqual(invokes, [["open_web_panel_login", { panelId: "files" }]]);
  // The contract is id-only: url and title must never ride the invoke.
  const [command, args] = invokes[0];
  assert.equal(command, "open_web_panel_login");
  assert.deepEqual(Object.keys(args), ["panelId"]);
  resetWebPanelForTests();
});
