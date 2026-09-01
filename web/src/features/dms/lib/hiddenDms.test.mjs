import assert from "node:assert/strict";
import { test } from "node:test";
import { hideDm, loadHiddenDms, saveHiddenDms, unhideDm } from "./hiddenDms.ts";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.get(k) ?? null;
  }
  setItem(k, v) {
    this.map.set(k, v);
  }
}

test("hideDm appends once (no duplicates)", () => {
  assert.deepEqual(hideDm([], "a"), ["a"]);
  assert.deepEqual(hideDm(["a"], "a"), ["a"]);
});

test("unhideDm removes only the target", () => {
  assert.deepEqual(unhideDm(["a", "b"], "a"), ["b"]);
  assert.deepEqual(unhideDm(["a"], "zzz"), ["a"]);
});

test("save→load round-trips and dedupes", () => {
  const storage = new MemoryStorage();
  saveHiddenDms(storage, ["a", "a", "b"]);
  assert.deepEqual(loadHiddenDms(storage), ["a", "b"]);
});

test("load tolerates null storage, missing, and corrupt data", () => {
  assert.deepEqual(loadHiddenDms(null), []);
  const storage = new MemoryStorage();
  assert.deepEqual(loadHiddenDms(storage), []);
  storage.setItem("buzz:dm-hidden", "{not json");
  assert.deepEqual(loadHiddenDms(storage), []);
  storage.setItem("buzz:dm-hidden", JSON.stringify({ nope: true }));
  assert.deepEqual(loadHiddenDms(storage), []);
});
