import assert from "node:assert/strict";
import { test } from "node:test";

import { createDockStore, FILES_DOCK_SCOPE } from "./dockStore.ts";

const STORAGE_KEY = "test:dock-store.v1";
const PANELS = [
  { id: "files", label: "Files", url: "https://files.example/", custom: false },
  {
    id: "custom:1",
    label: "Notes",
    url: "https://notes.example/",
    custom: true,
  },
];
const _KNOWN = new Set(PANELS.map((panel) => panel.id));

function memoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    raw: store,
  };
}

function withStorage(map) {
  const backing = memoryStorage(map);
  globalThis.localStorage = backing;
  return () => {
    delete globalThis.localStorage;
  };
}

function store() {
  const created = createDockStore({
    storageKey: STORAGE_KEY,
    initialScope: FILES_DOCK_SCOPE,
  });
  created.resetForTests();
  created.setPanels(PANELS);
  return created;
}

test("tabs open, activate, and persist under the store's key", () => {
  const restoreStorage = withStorage({});
  try {
    const dock = store();
    const result = dock.open("files");
    assert.equal(result.ok, true);
    assert.equal(dock.getSnapshot().activeInstanceId, "files#1");

    const raw = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY));
    assert.deepEqual(Object.keys(raw), ["version", "byScope"]);
    assert.ok(raw.byScope[FILES_DOCK_SCOPE]);
    assert.equal(raw.byScope[FILES_DOCK_SCOPE].instances.length, 1);
  } finally {
    restoreStorage();
  }
});

test("setPanels prunes tabs whose panel the registry dropped", () => {
  const restoreStorage = withStorage({});
  try {
    const dock = store();
    dock.open("custom:1");
    assert.equal(dock.getSnapshot().instances.length, 1);

    dock.setPanels([PANELS[0]]);
    assert.deepEqual(dock.getSnapshot().instances, []);
  } finally {
    restoreStorage();
  }
});

test("an empty registry prunes NOTHING (the setup-screen guard)", () => {
  const restoreStorage = withStorage({});
  try {
    const dock = store();
    dock.open("files");
    dock.setPanels([]);
    assert.equal(dock.getSnapshot().instances.length, 1);
    // And the session is still on disk — nothing was destroyed.
    const raw = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY));
    assert.equal(raw.byScope[FILES_DOCK_SCOPE].instances.length, 1);
  } finally {
    restoreStorage();
  }
});

test("setScope swaps the session; each scope restores its own tabs", () => {
  const restoreStorage = withStorage({});
  try {
    const dock = createDockStore({ storageKey: STORAGE_KEY });
    dock.resetForTests();
    dock.setPanels(PANELS);
    dock.setScope("channel-a");
    dock.open("files");
    dock.setScope("channel-b");
    assert.deepEqual(dock.getSnapshot().instances, []);

    dock.setScope("channel-a");
    assert.deepEqual(
      dock.getSnapshot().instances.map((instance) => instance.instanceId),
      ["files#1"],
    );
  } finally {
    restoreStorage();
  }
});

test("sessions reload from storage in a fresh store (per-scope)", () => {
  const restoreStorage = withStorage({});
  try {
    const writer = createDockStore({ storageKey: STORAGE_KEY });
    writer.setPanels(PANELS);
    writer.setScope("channel-a");
    writer.open("custom:1");

    const reader = createDockStore({ storageKey: STORAGE_KEY });
    reader.setPanels(PANELS);
    reader.setScope("channel-a");
    assert.deepEqual(
      reader.getSnapshot().instances.map((instance) => instance.panelId),
      ["custom:1"],
    );
    // A scope with no session stayed empty.
    reader.setScope("channel-b");
    assert.deepEqual(reader.getSnapshot().instances, []);
  } finally {
    restoreStorage();
  }
});

test("the legacy flat session file is adopted as the Files scope", () => {
  const legacy = {
    instances: [{ instanceId: "custom:1#7", panelId: "custom:1" }],
    activeInstanceId: "custom:1#7",
    nextSeq: 8,
  };
  const restoreStorage = withStorage({ [STORAGE_KEY]: JSON.stringify(legacy) });
  try {
    const dock = createDockStore({
      storageKey: STORAGE_KEY,
      initialScope: FILES_DOCK_SCOPE,
    });
    dock.setPanels(PANELS);
    assert.deepEqual(
      dock.getSnapshot().instances.map((instance) => instance.instanceId),
      ["custom:1#7"],
    );
    assert.equal(dock.getSnapshot().nextSeq, 8);
  } finally {
    restoreStorage();
  }
});

test("open refuses panels the registry does not know", () => {
  const restoreStorage = withStorage({});
  try {
    const dock = store();
    assert.deepEqual(dock.open("custom:99"), {
      ok: false,
      reason: "unknown-panel",
    });
  } finally {
    restoreStorage();
  }
});

test("subscribers are notified of session changes, not of registry syncs", () => {
  const restoreStorage = withStorage({});
  try {
    const dock = store();
    let notified = 0;
    const unsubscribe = dock.subscribe(() => {
      notified += 1;
    });
    dock.setPanels(PANELS); // same registry: no session change, no notify
    assert.equal(notified, 0);
    dock.open("files");
    assert.equal(notified, 1);
    dock.close("files#1");
    assert.equal(notified, 2);
    unsubscribe();
    dock.open("files");
    assert.equal(notified, 2);
  } finally {
    restoreStorage();
  }
});
