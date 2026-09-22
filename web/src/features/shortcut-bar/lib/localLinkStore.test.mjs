import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_LINKS_STORAGE_KEY,
  linkStorageMode,
  mutateLocalLinks,
  readLocalLinks,
} from "./localLinkStore.ts";
import {
  addSidebarShortcut,
  removeSidebarShortcut,
  updateSidebarShortcut,
} from "./shortcutBlob.ts";

// Node 26 ships a `localStorage` getter on globalThis that evaluates to
// undefined without --localstorage-file; remove it so the store under test
// sees only the storage each case installs (dockStore.test.mjs pattern).
delete globalThis.localStorage;

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

function add(input) {
  return mutateLocalLinks((blob) => addSidebarShortcut(blob, input));
}

test("the canUse branch: local key stays on the blob, everyone else on localStorage", () => {
  // This is the wiring that keeps local-key sessions OFF localStorage: the
  // hook only reaches for mutateLocalLinks when the mode is "local", and the
  // blob path never calls into this module.
  assert.equal(linkStorageMode(true), "blob");
  assert.equal(linkStorageMode(false), "local");
});

test("nothing stored reads as an EMPTY list, not an error", () => {
  const restore = withStorage({});
  try {
    assert.deepEqual(readLocalLinks(), []);
  } finally {
    restore();
  }
});

test("no storage at all still reads as empty and refuses writes with a reason", async () => {
  const result = await add({ url: "https://kept.example/" });
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, "string");
  assert.deepEqual(readLocalLinks(), []);
});

test("malformed or wrong-shape storage reads as empty", () => {
  for (const bad of [
    "not json",
    '{"v":1,"links":[]}',
    '{"v":9,"shortcuts":{}}',
  ]) {
    const restore = withStorage({ [LOCAL_LINKS_STORAGE_KEY]: bad });
    try {
      assert.deepEqual(readLocalLinks(), [], bad);
    } finally {
      restore();
    }
  }
});

test("localStorage round-trip CRUD: add, update, remove, persisted under the key", async () => {
  const restore = withStorage({});
  try {
    const added = await add({
      url: "https://kept.example/roadmap",
      label: "Roadmap",
      mode: "overlay",
    });
    assert.equal(added.ok, true, added.message);
    assert.deepEqual(
      readLocalLinks().map((link) => [link.id, link.label, link.mode]),
      [["sc:1", "Roadmap", "overlay"]],
    );

    // The file on disk is the hardened blob shape under the pinned key.
    const raw = JSON.parse(
      globalThis.localStorage.getItem(LOCAL_LINKS_STORAGE_KEY),
    );
    assert.equal(raw.v, 1);
    assert.ok(Array.isArray(raw.shortcuts.__sidebar__));

    const second = await add({
      url: "https://status.example/",
      label: "Status",
    });
    assert.equal(second.ok, true, second.message);
    assert.deepEqual(
      readLocalLinks().map((link) => link.id),
      ["sc:1", "sc:2"],
      "ids allocate upward, never reusing a removed one",
    );

    const updated = await mutateLocalLinks((blob) =>
      updateSidebarShortcut(blob, "sc:1", {
        url: "https://kept.example/board",
        label: "Board",
        mode: "window",
      }),
    );
    assert.equal(updated.ok, true, updated.message);
    assert.deepEqual(
      readLocalLinks().map((link) => [link.label, link.url, link.mode]),
      [
        ["Board", "https://kept.example/board", "window"],
        ["Status", "https://status.example/", "window"],
      ],
      "update keeps id and position, default mode is a browser tab",
    );

    const removed = await mutateLocalLinks((blob) =>
      removeSidebarShortcut(blob, "sc:1"),
    );
    assert.equal(removed.ok, true, removed.message);
    assert.deepEqual(
      readLocalLinks().map((link) => link.id),
      ["sc:2"],
    );

    await mutateLocalLinks((blob) => removeSidebarShortcut(blob, "sc:2"));
    assert.deepEqual(readLocalLinks(), [], "the last removal empties the list");
    assert.ok(
      typeof globalThis.localStorage.getItem(LOCAL_LINKS_STORAGE_KEY) ===
        "string",
      "the emptied file persists as an authoritative empty list",
    );
  } finally {
    restore();
  }
});

test("the blob's validation is the local store's validation", async () => {
  const restore = withStorage({});
  try {
    const refused = await add({ url: "javascript:alert(1)" });
    assert.equal(refused.ok, false);
    assert.equal(
      globalThis.localStorage.getItem(LOCAL_LINKS_STORAGE_KEY),
      null,
      "a refused mutation persists nothing",
    );
  } finally {
    restore();
  }
});

test("a setItem that throws is a refused mutation, not a crash", async () => {
  const restore = withStorage({});
  globalThis.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  try {
    const result = await add({ url: "https://kept.example/" });
    assert.equal(result.ok, false);
    assert.equal(typeof result.message, "string");
  } finally {
    restore();
  }
});
