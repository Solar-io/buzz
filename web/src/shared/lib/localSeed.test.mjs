import assert from "node:assert/strict";
import { test } from "node:test";

// localSeed touches window.localStorage at CALL time, so a stub installed
// before the dynamic import is enough.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
const { loadSeed, mergeSeed } = await import("./localSeed.ts");

test("mergeSeed unions across writers instead of clobbering", () => {
  mergeSeed("profiles:v1", { aa: { name: "A" } });
  mergeSeed("profiles:v1", { bb: { name: "B" } });
  const seed = loadSeed("profiles:v1");
  assert.equal(seed.aa?.name, "A", "first writer's entry survives");
  assert.equal(seed.bb?.name, "B", "second writer's entry lands");
});

test("mergeSeed overwrites a key's value on purpose (latest wins per key)", () => {
  mergeSeed("profiles:v1", { aa: { name: "A2" } });
  assert.equal(loadSeed("profiles:v1").aa?.name, "A2");
});

test("corrupt storage reads as empty, never throws", () => {
  store.set("bad:v1", "{not json");
  assert.deepEqual(loadSeed("bad:v1"), {});
  store.set("array:v1", "[1,2,3]");
  assert.deepEqual(loadSeed("array:v1"), {}, "array payloads are rejected");
});

test("empty merges are no-ops", () => {
  const before = store.get("profiles:v1");
  mergeSeed("profiles:v1", {});
  assert.equal(store.get("profiles:v1"), before);
});
