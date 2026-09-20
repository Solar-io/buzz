import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * The asks cache against a FAKE idb-keyval, installed at the module seam.
 * `askCache.test.mjs` runs against the real one, which throws under node (no
 * IndexedDB) — that pins the cold-start discipline but can never observe what
 * the cache actually does to storage. This file observes it: the version bump
 * from "v1" to "v2" orphaned every stale entry, and an orphan nobody deletes
 * is a leak that outlives the build that made it.
 */
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "idb-keyval": `
    const store = globalThis.__BUZZ_TEST_IDB__;
    export async function get(key) {
      store.calls.push(["get", key]);
      return store.data.get(key);
    }
    export async function set(key, value) {
      store.calls.push(["set", key]);
      store.data.set(key, value);
    }
    export async function del(key) {
      store.calls.push(["del", key]);
      store.data.delete(key);
    }
  `,
};

globalThis.__BUZZ_TEST_IDB__ = { data: new Map(), calls: [] };

const { asksCacheKey, dropSupersededAsksCaches, loadAsksCache, saveAsksCache } =
  await import("./askCache.ts");

const store = globalThis.__BUZZ_TEST_IDB__;

function reset() {
  store.data = new Map();
  store.calls = [];
}

after(() => {
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__BUZZ_TEST_IDB__;
});

test("the fake store is wired — a save is readable back through the cache", async () => {
  // Harness self-check first: an inert stub would make every assertion below
  // vacuously true.
  reset();
  const entry = { asks: [], answered: { a: "b" }, cursor: 7 };
  await saveAsksCache(entry);
  assert.deepEqual(store.data.get("asks:v2"), entry);
  assert.deepEqual(await loadAsksCache(), entry);
});

test("loading deletes the superseded asks:v1 entry and keeps the current one", async () => {
  reset();
  store.data.set("asks:v1", { asks: ["stale"], answered: {}, cursor: 1 });
  const current = { asks: [], answered: {}, cursor: 2 };
  store.data.set(asksCacheKey(), current);

  const loaded = await loadAsksCache();

  assert.equal(store.data.has("asks:v1"), false, "the orphan must be deleted");
  assert.deepEqual(loaded, current, "the current entry must survive the sweep");
  assert.deepEqual(
    store.calls.filter(([op]) => op === "del"),
    [["del", "asks:v1"]],
    "exactly one delete, and it is not the live key",
  );
});

test("the sweep never deletes the key in use", async () => {
  reset();
  const current = { asks: [], answered: {}, cursor: 3 };
  store.data.set(asksCacheKey(), current);
  await dropSupersededAsksCaches();
  assert.deepEqual(store.data.get(asksCacheKey()), current);
  assert.equal(asksCacheKey(), "asks:v2");
});
