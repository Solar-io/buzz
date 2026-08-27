import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

const invokes = [];

let registry;

const ERROR = Symbol("reject");
let responses = {};

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
  });
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      invokes.push([command, args]);
      const response = responses[command];
      if (response === ERROR) {
        return Promise.reject(new Error("backend refused"));
      }
      return Promise.resolve(
        typeof response === "function" ? response() : (response ?? null),
      );
    },
  };
  registry = await import("./webPanelRegistry.ts");
});

after(() => {
  dom.window.close();
});

beforeEach(() => {
  invokes.length = 0;
  responses = {};
  registry.resetWebPanelRegistryForTests();
});

function respond(command, response) {
  responses[command] = response;
}

const DOCS = { id: "site-1", label: "Docs", title: "Docs" };

test("the registry starts statics-only", async () => {
  assert.deepEqual(
    registry.allWebPanels().map((panel) => panel.id),
    ["files"],
  );
  assert.equal(registry.getWebPanel("site-1"), null);
  await registry.customPanelsReady();
  assert.deepEqual(
    registry.allWebPanels().map((panel) => panel.id),
    ["files"],
    "an empty backend list must not add customs",
  );
});

test("customPanelsReady merges customs behind the statics", async () => {
  respond("list_custom_panels", [DOCS]);
  await registry.customPanelsReady();
  const all = registry.allWebPanels();
  assert.deepEqual(
    all.map((panel) => panel.id),
    ["files", "site-1"],
  );
  const custom = registry.getWebPanel("site-1");
  assert.ok(custom, "custom id must resolve after load");
  assert.equal(custom.label, "Docs");
  assert.equal(custom.url, null, "the url never crosses the IPC boundary");
  assert.equal(custom.render, "native");
  assert.equal(custom.custom, true);
  // Statics resolve unchanged with customs present.
  assert.equal(registry.getWebPanel("files")?.id, "files");
  assert.equal(registry.getWebPanel("site-2"), null);
});

test("malformed backend entries are dropped, not crashed on", async () => {
  respond("list_custom_panels", [
    null,
    {},
    { id: "" },
    { id: "site-1" },
    { id: "site-2", label: "NoTitle" },
    { id: "site-3", label: "BadTitle", title: 7 },
    "files",
  ]);
  await registry.customPanelsReady();
  assert.deepEqual(
    registry.customWebPanels().map((info) => `${info.id}:${info.title}`),
    ["site-2:NoTitle", "site-3:BadTitle"],
  );
});

test("a failed list disables customs for the run without touching statics", async () => {
  respond("list_custom_panels", ERROR);
  await registry.customPanelsReady();
  assert.equal(registry.customPanelPhase(), "failed");
  assert.deepEqual(registry.customWebPanels(), []);
  assert.equal(registry.getWebPanel("site-1"), null);
  assert.equal(registry.getWebPanel("files")?.id, "files");
});

test("add flow: added outcome refreshes the registry", async () => {
  respond("add_custom_panel", {
    status: "added",
    panel: { id: "site-2", label: "Wiki", title: "Wiki" },
  });
  respond("list_custom_panels", () => [
    DOCS,
    { id: "site-2", label: "Wiki", title: "Wiki" },
  ]);
  const outcome = await registry.addCustomSite();
  assert.deepEqual(outcome, {
    status: "added",
    panel: { id: "site-2", label: "Wiki", title: "Wiki" },
  });
  assert.deepEqual(
    invokes.map(([command]) => command),
    ["add_custom_panel", "list_custom_panels"],
  );
  assert.equal(registry.getWebPanel("site-2")?.label, "Wiki");
});

test("add flow: cancelled outcome does not refresh", async () => {
  respond("add_custom_panel", { status: "cancelled" });
  const outcome = await registry.addCustomSite();
  assert.deepEqual(outcome, { status: "cancelled" });
  assert.deepEqual(
    invokes.map(([command]) => command),
    ["add_custom_panel"],
    "a cancelled dialog must not trigger a refresh",
  );
});

test("remove flow: removed when the id stops resolving", async () => {
  respond("list_custom_panels", () => []);
  const result = await registry.removeCustomSite("site-1");
  assert.equal(result, "removed");
  assert.deepEqual(invokes, [
    ["remove_custom_panel", { id: "site-1" }],
    ["list_custom_panels", {}],
  ]);
  assert.equal(registry.getWebPanel("site-1"), null);
});

test("remove flow: still-present when the id survives the refresh", async () => {
  respond("list_custom_panels", () => [DOCS]);
  const result = await registry.removeCustomSite("site-1");
  assert.equal(result, "still-present");
});

test("registry listeners fire on load and on refresh", async () => {
  const events = [];
  const unsubscribe = registry.subscribeWebPanelRegistry(() =>
    events.push("tick"),
  );
  respond("list_custom_panels", [DOCS]);
  await registry.customPanelsReady();
  await registry.refreshCustomPanels();
  unsubscribe();
  await registry.refreshCustomPanels();
  // One notification per settled load: the first load + the first refresh;
  // the post-unsubscribe refresh must not tick.
  assert.equal(events.length, 2);
  assert.ok(events.length > 0);
});
