import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

let closeWebPanelInstance;
let getWebPanelSnapshotForTests;
let openWebPanelInstance;
let parseWebPanelSession;
let resetWebPanelForTests;
let restoreWebPanelSessionForTests;
let serializeWebPanelSession;
let setActiveWebPanelInstance;
let setWebPanelInstanceHeight;
let setWebPanelMode;
let nextSequenceAfter;
let toggleWebPanel;
let WEBPANEL_SESSION_STORAGE_KEY;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
  });
  ({
    closeWebPanelInstance,
    getWebPanelSnapshotForTests,
    openWebPanelInstance,
    parseWebPanelSession,
    resetWebPanelForTests,
    restoreWebPanelSessionForTests,
    serializeWebPanelSession,
    setActiveWebPanelInstance,
    setWebPanelInstanceHeight,
    setWebPanelMode,
    nextSequenceAfter,
    toggleWebPanel,
    WEBPANEL_SESSION_STORAGE_KEY,
  } = await import("./webPanelStore.ts"));
});

after(() => {
  dom.window.close();
});

beforeEach(() => {
  resetWebPanelForTests();
  dom.window.localStorage.clear();
  restoreWebPanelSessionForTests();
});

function seedSession(payload) {
  dom.window.localStorage.setItem(
    WEBPANEL_SESSION_STORAGE_KEY,
    JSON.stringify(payload),
  );
  restoreWebPanelSessionForTests();
}

const flushPersist = () => new Promise((resolve) => setTimeout(resolve, 350));

test("opening a panel creates a tabbed instance and docks it", () => {
  const result = openWebPanelInstance("files");
  assert.deepEqual(result, { ok: true, instanceId: "files-1" });
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.mode, "docked");
  assert.equal(snapshot.instances.length, 1);
  assert.equal(snapshot.instances[0].panelId, "files");
  assert.equal(snapshot.instances[0].height, null);
  assert.equal(snapshot.activeInstanceId, "files-1");
});

test("multiple instances of the same panel type are allowed", () => {
  openWebPanelInstance("files");
  const second = openWebPanelInstance("files");
  assert.equal(second.instanceId, "files-2");
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.instances.length, 2);
  assert.deepEqual(
    snapshot.instances.map((instance) => instance.instanceId),
    ["files-1", "files-2"],
  );
  assert.equal(snapshot.activeInstanceId, "files-2");
});

test("live instances are capped at six and the failure says why", () => {
  for (let index = 0; index < 6; index += 1) {
    const result = openWebPanelInstance("files");
    assert.equal(result.ok, true, `open ${index} must succeed`);
  }
  const seventh = openWebPanelInstance("files");
  assert.deepEqual(seventh, { ok: false, reason: "cap" });
  assert.equal(getWebPanelSnapshotForTests().instances.length, 6);
});

test("unknown panel types are refused", () => {
  assert.deepEqual(openWebPanelInstance("nope"), {
    ok: false,
    reason: "unknown-panel",
  });
});

test("closing the active tab activates its neighbor and closes the dock with the last tab", () => {
  openWebPanelInstance("files");
  openWebPanelInstance("files");
  openWebPanelInstance("files");
  // Active is files-3; closing it falls back to the tab before it.
  closeWebPanelInstance("files-3");
  let snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.activeInstanceId, "files-2");
  assert.equal(snapshot.instances.length, 2);
  assert.equal(snapshot.mode, "docked");
  // Closing a non-active tab leaves the active alone.
  closeWebPanelInstance("files-1");
  snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.activeInstanceId, "files-2");
  // Closing the last tab closes the dock entirely.
  closeWebPanelInstance("files-2");
  snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.mode, "closed");
  assert.equal(snapshot.instances.length, 0);
  assert.equal(snapshot.activeInstanceId, null);
});

test("closing the first tab with no left neighbor activates the next tab", () => {
  openWebPanelInstance("files");
  openWebPanelInstance("files");
  closeWebPanelInstance("files-1");
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.activeInstanceId, "files-2");
});

test("switching tabs keeps every instance alive", () => {
  openWebPanelInstance("files");
  openWebPanelInstance("files");
  setActiveWebPanelInstance("files-1");
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.instances.length, 2, "switch must not close tabs");
  assert.equal(snapshot.activeInstanceId, "files-1");
});

test("toggle closes the active tab of the type, then reopens fresh", () => {
  const opened = toggleWebPanel("files");
  assert.equal(opened.ok, true);
  let snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.instances.length, 1);
  // Active tab is of this type: toggle closes it.
  const closed = toggleWebPanel("files");
  assert.equal(closed, null);
  snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.mode, "closed");
  assert.equal(snapshot.instances.length, 0);
  const reopened = toggleWebPanel("files");
  assert.equal(reopened.ok, true);
  assert.equal(reopened.instanceId, "files-2");
});

test("instance ids never repeat across close and reopen cycles", () => {
  openWebPanelInstance("files");
  closeWebPanelInstance("files-1");
  const reopened = openWebPanelInstance("files");
  assert.equal(reopened.instanceId, "files-2");
});

test("per-tab heights clamp and round, and unknown ids are ignored", () => {
  openWebPanelInstance("files");
  openWebPanelInstance("files");
  setActiveWebPanelInstance("files-1");
  setWebPanelInstanceHeight("files-1", 410.4);
  // jsdom viewport is 768px tall: 70% is 537.6, so a tall value clamps to 538.
  setWebPanelInstanceHeight("files-2", 10_000);
  setWebPanelInstanceHeight("files-2", Number.NaN);
  setWebPanelInstanceHeight("missing-1", 400);
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.instances[0].height, 410);
  assert.equal(snapshot.instances[1].height, 538);
});

test("closing the dock clears every tab", () => {
  openWebPanelInstance("files");
  openWebPanelInstance("files");
  setWebPanelMode("closed");
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.mode, "closed");
  assert.equal(snapshot.instances.length, 0);
});

test("maximize keeps the tabs and only changes the mode", () => {
  openWebPanelInstance("files");
  setWebPanelMode("maximized");
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.mode, "maximized");
  assert.equal(snapshot.instances.length, 1);
});

// ── Session persistence ─────────────────────────────────────────────────

test("session serializes open tabs, order, active tab, and mode", () => {
  openWebPanelInstance("files");
  openWebPanelInstance("files");
  setWebPanelInstanceHeight("files-1", 410);
  setActiveWebPanelInstance("files-1");
  setWebPanelMode("maximized");
  const snapshot = getWebPanelSnapshotForTests();
  const payload = serializeWebPanelSession(snapshot);
  assert.deepEqual(payload, {
    version: 1,
    mode: "maximized",
    instances: [
      { instanceId: "files-1", panelId: "files", height: 410 },
      { instanceId: "files-2", panelId: "files", height: null },
    ],
    activeInstanceId: "files-1",
  });
});

test("a closed dock serializes to nothing", () => {
  openWebPanelInstance("files");
  setWebPanelMode("closed");
  assert.equal(serializeWebPanelSession(getWebPanelSnapshotForTests()), null);
});

test("persisted sessions are written to localStorage (debounced)", async () => {
  openWebPanelInstance("files");
  // Before the debounce fires there is nothing on disk yet.
  assert.equal(
    dom.window.localStorage.getItem(WEBPANEL_SESSION_STORAGE_KEY),
    null,
  );
  await flushPersist();
  const raw = dom.window.localStorage.getItem(WEBPANEL_SESSION_STORAGE_KEY);
  assert.ok(raw, "session must persist after the debounce window");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.instances.length, 1);
  assert.equal(parsed.instances[0].instanceId, "files-1");
});

test("closing the dock removes the persisted session", async () => {
  openWebPanelInstance("files");
  await flushPersist();
  assert.ok(dom.window.localStorage.getItem(WEBPANEL_SESSION_STORAGE_KEY));
  setWebPanelMode("closed");
  await flushPersist();
  assert.equal(
    dom.window.localStorage.getItem(WEBPANEL_SESSION_STORAGE_KEY),
    null,
  );
});

test("session restore round-trips tabs, heights, order, and active tab", () => {
  seedSession({
    version: 1,
    mode: "maximized",
    instances: [
      { instanceId: "files-7", panelId: "files", height: 410 },
      { instanceId: "files-9", panelId: "files", height: null },
    ],
    activeInstanceId: "files-9",
  });
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.mode, "maximized");
  assert.deepEqual(
    snapshot.instances.map((i) => [i.instanceId, i.height]),
    [
      ["files-7", 410],
      ["files-9", null],
    ],
  );
  assert.equal(snapshot.activeInstanceId, "files-9");
});

test("restore never reuses an instance id a restored session owns", () => {
  seedSession({
    version: 1,
    mode: "docked",
    instances: [
      { instanceId: "files-7", panelId: "files", height: null },
      { instanceId: "files-12", panelId: "files", height: null },
    ],
    activeInstanceId: "files-12",
  });
  const opened = openWebPanelInstance("files");
  assert.equal(opened.instanceId, "files-13");
  assert.equal(nextSequenceAfter(getWebPanelSnapshotForTests().instances), 14);
});

test("corrupted payloads restore to a clean closed dock", () => {
  for (const bad of ["not json", "[]", "{}", '{"version":2}', "null"]) {
    dom.window.localStorage.setItem(WEBPANEL_SESSION_STORAGE_KEY, bad);
    resetWebPanelForTests();
    restoreWebPanelSessionForTests();
    const snapshot = getWebPanelSnapshotForTests();
    assert.equal(snapshot.mode, "closed", `payload ${bad} must not restore`);
    assert.equal(snapshot.instances.length, 0);
  }
});

test("restore drops stale panel ids, duplicate ids, and over-cap overflow", () => {
  seedSession({
    version: 1,
    mode: "docked",
    instances: [
      { instanceId: "files-1", panelId: "files", height: null },
      { instanceId: "old-2", panelId: "retired-panel", height: 300 },
      { instanceId: "files-1", panelId: "files", height: null },
      { instanceId: "files-3", panelId: "files", height: null },
      { instanceId: "files-4", panelId: "files", height: null },
      { instanceId: "files-5", panelId: "files", height: null },
      { instanceId: "files-6", panelId: "files", height: null },
      { instanceId: "files-7", panelId: "files", height: null },
      { instanceId: "files-8", panelId: "files", height: null },
    ],
    activeInstanceId: "files-8",
  });
  const snapshot = getWebPanelSnapshotForTests();
  assert.equal(snapshot.instances.length, 6, "cap applies on restore");
  assert.ok(
    snapshot.instances.every((i) => i.panelId === "files"),
    "unknown panel types must be dropped",
  );
  // Kept in order: files-1, files-3..files-7 (the duplicate and the
  // stale-panel entries never consume cap slots), so files-8 overflows and
  // the dangling active id falls to the newest survivor.
  assert.equal(
    snapshot.activeInstanceId,
    "files-7",
    "dangling active id falls back to the last restored tab",
  );
});

test("an empty payload restores nothing", () => {
  dom.window.localStorage.removeItem(WEBPANEL_SESSION_STORAGE_KEY);
  resetWebPanelForTests();
  restoreWebPanelSessionForTests();
  assert.equal(getWebPanelSnapshotForTests().mode, "closed");
  assert.equal(parseWebPanelSession(null), null);
  assert.equal(parseWebPanelSession(""), null);
});

test("parse validates shape instead of trusting it", () => {
  assert.equal(parseWebPanelSession('{"version":1}'), null);
  assert.equal(parseWebPanelSession('{"version":1,"instances":{}}'), null);
  assert.equal(
    parseWebPanelSession(
      '{"version":1,"instances":[{"instanceId":"x","panelId":"nope"}]}',
    ),
    null,
    "no known panel type means nothing to restore",
  );
  // Non-numeric heights are dropped, not fatal.
  const recovered = parseWebPanelSession(
    '{"version":1,"instances":[{"instanceId":"files-1","panelId":"files","height":"tall"}],"activeInstanceId":"files-1"}',
  );
  assert.equal(recovered.instances[0].height, null);
});
