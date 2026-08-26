import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  getWebPanelSnapshotForTests,
  resetWebPanelForTests,
  setWebPanelMode,
  toggleWebPanel,
} from "./webPanelStore.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

let act;
let cleanup;
let createElement;
let render;
let useWebPanel;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  ({ act, cleanup, render } = await import("@testing-library/react"));
  ({ createElement } = await import("react"));
  ({ useWebPanel } = await import("./webPanelStore.ts"));
});

after(() => {
  cleanup?.();
  dom.window.close();
});

beforeEach(resetWebPanelForTests);

test("toggle opens a closed panel docked", () => {
  toggleWebPanel("files");
  assert.deepEqual(getWebPanelSnapshotForTests(), {
    mode: "docked",
    openPanelId: "files",
  });
});

test("toggling the open panel closes it", () => {
  toggleWebPanel("files");
  toggleWebPanel("files");
  assert.deepEqual(getWebPanelSnapshotForTests(), {
    mode: "closed",
    openPanelId: null,
  });
});

test("opening another panel replaces it instead of stacking", () => {
  toggleWebPanel("files");
  toggleWebPanel("notes");
  assert.deepEqual(getWebPanelSnapshotForTests(), {
    mode: "docked",
    openPanelId: "notes",
  });
});

test("replacing a panel keeps the current mode", () => {
  toggleWebPanel("files");
  setWebPanelMode("maximized");
  toggleWebPanel("notes");
  assert.deepEqual(getWebPanelSnapshotForTests(), {
    mode: "maximized",
    openPanelId: "notes",
  });
});

test("reopening the closed panel via toggle returns it docked", () => {
  toggleWebPanel("files");
  setWebPanelMode("closed");
  toggleWebPanel("files");
  assert.deepEqual(getWebPanelSnapshotForTests(), {
    mode: "docked",
    openPanelId: "files",
  });
});

test("setWebPanelMode transitions without touching the open panel", () => {
  toggleWebPanel("files");
  setWebPanelMode("maximized");
  assert.deepEqual(getWebPanelSnapshotForTests(), {
    mode: "maximized",
    openPanelId: "files",
  });
  setWebPanelMode("closed");
  assert.deepEqual(getWebPanelSnapshotForTests(), {
    mode: "closed",
    openPanelId: "files",
  });
});

test("hook subscribers are notified on every published change", async () => {
  const observed = [];
  function Probe() {
    const panel = useWebPanel();
    observed.push(`${panel.mode}:${panel.openPanelId}`);
    return null;
  }
  render(createElement(Probe));
  // One act per operation: React batches synchronous publishes inside a
  // single act, which would collapse the notification trace.
  await act(async () => {
    toggleWebPanel("files");
  });
  await act(async () => {
    setWebPanelMode("maximized");
  });
  await act(async () => {
    setWebPanelMode("closed");
  });
  await act(async () => {
    toggleWebPanel("files");
  });
  await act(async () => {
    toggleWebPanel("files");
  });
  assert.deepEqual(observed, [
    "closed:null",
    "docked:files",
    "maximized:files",
    "closed:files",
    "docked:files",
    "closed:null",
  ]);
});

test("no-op transitions do not publish", () => {
  const before = getWebPanelSnapshotForTests();
  setWebPanelMode("closed");
  assert.equal(
    getWebPanelSnapshotForTests(),
    before,
    "same-mode set must be a no-op",
  );
});
