import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_PANEL_SNAPSHOT,
  MAX_PANEL_INSTANCES,
  PANEL_SESSION_STORAGE_KEY,
  activateInstance,
  closeInstance,
  focusOrOpen,
  nextSequenceAfter,
  openInstance,
  parsePanelSession,
  pruneUnknownPanels,
  readPanelSession,
  serializePanelSession,
  writePanelSession,
} from "./panelSession.ts";

const KNOWN = new Set(["files", "custom:1"]);

function openMany(count, panelId = "files") {
  let snapshot = EMPTY_PANEL_SNAPSHOT;
  for (let index = 0; index < count; index += 1) {
    const result = openInstance(snapshot, panelId, KNOWN);
    assert.equal(result.ok, true, `open ${index} should succeed`);
    snapshot = result.snapshot;
  }
  return snapshot;
}

test("opening a tab activates it and advances the allocator", () => {
  const result = openInstance(EMPTY_PANEL_SNAPSHOT, "files", KNOWN);
  assert.equal(result.ok, true);
  assert.equal(result.instanceId, "files#1");
  assert.equal(result.snapshot.activeInstanceId, "files#1");
  assert.equal(result.snapshot.nextSeq, 2);
});

test("the same site can be opened twice, as separate live tabs", () => {
  const snapshot = openMany(2);
  assert.deepEqual(
    snapshot.instances.map((instance) => instance.instanceId),
    ["files#1", "files#2"],
  );
});

test("an unknown panel id cannot be opened", () => {
  const result = openInstance(EMPTY_PANEL_SNAPSHOT, "custom:99", KNOWN);
  assert.deepEqual(result, { ok: false, reason: "unknown-panel" });
});

test("the instance cap is enforced", () => {
  const full = openMany(MAX_PANEL_INSTANCES);
  assert.deepEqual(openInstance(full, "files", KNOWN), {
    ok: false,
    reason: "cap",
  });
});

test("closing the active tab falls to its LEFT neighbour", () => {
  const three = openMany(3);
  const active = activateInstance(three, "files#2");
  const closed = closeInstance(active, "files#2");
  assert.equal(closed.activeInstanceId, "files#1");
});

test("closing the leftmost active tab falls to the new leftmost", () => {
  const three = openMany(3);
  const active = activateInstance(three, "files#1");
  const closed = closeInstance(active, "files#1");
  assert.equal(closed.activeInstanceId, "files#2");
});

test("closing a background tab leaves the active one alone", () => {
  const three = openMany(3);
  const active = activateInstance(three, "files#3");
  const closed = closeInstance(active, "files#1");
  assert.equal(closed.activeInstanceId, "files#3");
});

test("closing the last tab empties the dock", () => {
  const one = openMany(1);
  const closed = closeInstance(one, "files#1");
  assert.deepEqual(closed.instances, []);
  assert.equal(closed.activeInstanceId, null);
});

test("closing an id that is not open is a no-op", () => {
  const one = openMany(1);
  assert.equal(closeInstance(one, "files#99"), one);
});

test("activating an unknown or already-active instance is a no-op", () => {
  const two = openMany(2);
  assert.equal(activateInstance(two, "files#2"), two, "already active");
  assert.equal(activateInstance(two, "nope"), two, "not open");
});

test("focusOrOpen focuses an existing tab instead of opening another", () => {
  const two = openMany(2);
  const focused = focusOrOpen(activateInstance(two, "files#1"), "files", KNOWN);
  assert.equal(focused.ok, true);
  assert.equal(focused.instanceId, "files#2", "the newest tab of that type");
  assert.equal(focused.snapshot.instances.length, 2, "no new tab");
});

test("focusOrOpen opens when no tab of that type exists", () => {
  const opened = focusOrOpen(openMany(1), "custom:1", KNOWN);
  assert.equal(opened.ok, true);
  assert.equal(opened.snapshot.instances.length, 2);
});

test("removing a site closes its tabs and re-homes the active one", () => {
  let snapshot = openMany(1);
  snapshot = openInstance(snapshot, "custom:1", KNOWN).snapshot;
  assert.equal(snapshot.activeInstanceId, "custom:1#2");

  const pruned = pruneUnknownPanels(snapshot, new Set(["files"]));
  assert.deepEqual(
    pruned.instances.map((instance) => instance.instanceId),
    ["files#1"],
  );
  assert.equal(pruned.activeInstanceId, "files#1");
});

test("pruning nothing returns the identical snapshot", () => {
  const snapshot = openMany(2);
  assert.equal(pruneUnknownPanels(snapshot, KNOWN), snapshot);
});

test("a session round-trips through storage", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const snapshot = activateInstance(openMany(2), "files#1");
  writePanelSession(storage, snapshot);
  assert.deepEqual(readPanelSession(storage, KNOWN), snapshot);

  writePanelSession(storage, EMPTY_PANEL_SNAPSHOT);
  assert.equal(store.has(PANEL_SESSION_STORAGE_KEY), false);
  assert.equal(readPanelSession(storage, KNOWN), null);
});

test("an empty dock serializes to nothing rather than an empty session", () => {
  assert.equal(serializePanelSession(EMPTY_PANEL_SNAPSHOT), null);
});

test("restoring drops tabs whose site no longer exists", () => {
  const raw = JSON.stringify({
    version: 1,
    instances: [
      { instanceId: "files#1", panelId: "files" },
      { instanceId: "gone#2", panelId: "custom:9" },
    ],
    activeInstanceId: "gone#2",
    nextSeq: 3,
  });
  const restored = parsePanelSession(raw, KNOWN);
  assert.deepEqual(
    restored.instances.map((instance) => instance.instanceId),
    ["files#1"],
  );
  // The active id pointed at a dropped tab, so it falls to a surviving one.
  assert.equal(restored.activeInstanceId, "files#1");
});

test("a lagging persisted allocator cannot mint a duplicate instance id", () => {
  // nextSeq below is behind the ids it stored. Trusting it would produce a
  // second "files#7" and hand React two live iframes with the same key.
  const raw = JSON.stringify({
    version: 1,
    instances: [{ instanceId: "files#7", panelId: "files" }],
    activeInstanceId: "files#7",
    nextSeq: 2,
  });
  const restored = parsePanelSession(raw, KNOWN);
  assert.equal(restored.nextSeq, 8);
  const opened = openInstance(restored, "files", KNOWN);
  assert.equal(opened.instanceId, "files#8");
});

test("nextSequenceAfter reads the highest sequence present", () => {
  assert.equal(
    nextSequenceAfter([
      { instanceId: "files#3", panelId: "files" },
      { instanceId: "custom:1#11", panelId: "custom:1" },
    ]),
    12,
  );
  assert.equal(nextSequenceAfter([]), 1);
  assert.equal(
    nextSequenceAfter([{ instanceId: "junk", panelId: "files" }]),
    1,
  );
});

test("a corrupt, wrong-version, or empty session restores as nothing", () => {
  assert.equal(parsePanelSession(null, KNOWN), null);
  assert.equal(parsePanelSession("{oops", KNOWN), null);
  assert.equal(parsePanelSession("42", KNOWN), null);
  assert.equal(
    parsePanelSession(JSON.stringify({ version: 2, instances: [] }), KNOWN),
    null,
  );
  assert.equal(
    parsePanelSession(
      JSON.stringify({ version: 1, instances: [{ panelId: "files" }] }),
      KNOWN,
    ),
    null,
    "an instance with no id is unusable",
  );
});

test("a restored session cannot exceed the instance cap", () => {
  const raw = JSON.stringify({
    version: 1,
    instances: Array.from({ length: MAX_PANEL_INSTANCES + 4 }, (_, index) => ({
      instanceId: `files#${index + 1}`,
      panelId: "files",
    })),
    activeInstanceId: "files#1",
    nextSeq: 1,
  });
  const restored = parsePanelSession(raw, KNOWN);
  assert.equal(restored.instances.length, MAX_PANEL_INSTANCES);
});
