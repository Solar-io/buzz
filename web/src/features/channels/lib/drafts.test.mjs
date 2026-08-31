import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { clearDraft, loadDraft, saveDraft } from "./drafts.ts";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

test("drafts round-trip per channel without cross-talk", () => {
  saveDraft("ch1", "hello world");
  saveDraft("ch2", "other");
  assert.equal(loadDraft("ch1"), "hello world");
  assert.equal(loadDraft("ch2"), "other");
  assert.equal(loadDraft("ch3"), "", "unknown channel has no draft");
});

test("clearing a draft removes only that channel's entry", () => {
  saveDraft("ch1", "keep me");
  saveDraft("ch2", "gone");
  clearDraft("ch2");
  assert.equal(loadDraft("ch2"), "");
  assert.equal(loadDraft("ch1"), "keep me");
  // Saving empty text is the same as clearing.
  saveDraft("ch1", "");
  assert.equal(loadDraft("ch1"), "");
});

test("drafts survive storage round-trip (JSON persisted)", () => {
  saveDraft("ch1", "persisted");
  const raw = globalThis.localStorage.getItem("buzz.drafts.v1");
  assert.ok(raw.includes("ch1"), "draft map is persisted as JSON");
  // Simulate a fresh session: a new storage seeded with the same raw value.
  const fresh = memoryStorage();
  fresh.setItem("buzz.drafts.v1", raw);
  globalThis.localStorage = fresh;
  assert.equal(loadDraft("ch1"), "persisted");
});

test("corrupted storage degrades to no drafts", () => {
  globalThis.localStorage.setItem("buzz.drafts.v1", "{not json");
  assert.equal(loadDraft("ch1"), "");
  saveDraft("ch1", "recovers");
  assert.equal(loadDraft("ch1"), "recovers");
});
