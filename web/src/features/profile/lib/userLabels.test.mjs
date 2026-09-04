import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_USER_LABEL_LENGTH,
  USER_LABELS_STORAGE_KEY,
  isRenamed,
  labelledName,
  normalizeLabel,
  readUserLabels,
  setUserLabel,
  writeUserLabels,
} from "./userLabels.ts";

const ALICE = "a".repeat(64);

function memoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    raw: store,
  };
}

test("labels are trimmed, collapsed, and clamped", () => {
  assert.equal(normalizeLabel("  Ada   Lovelace  "), "Ada Lovelace");
  assert.equal(normalizeLabel("x".repeat(200)).length, MAX_USER_LABEL_LENGTH);
  assert.equal(normalizeLabel("   "), "");
});

test("setting a label keys it by lowercased pubkey", () => {
  const labels = setUserLabel({}, ALICE.toUpperCase(), " Ada ");
  assert.deepEqual(labels, { [ALICE]: "Ada" });
});

test("setting an empty label removes the entry", () => {
  const labels = setUserLabel({ [ALICE]: "Ada" }, ALICE, "   ");
  assert.deepEqual(labels, {});
});

test("a local label wins over the published name", () => {
  assert.equal(
    labelledName({ [ALICE]: "Ada" }, ALICE, "alice", "aaaa…aaaa"),
    "Ada",
  );
});

test("without a label the published name wins, then the fallback", () => {
  assert.equal(labelledName({}, ALICE, "alice", "aaaa…aaaa"), "alice");
  assert.equal(labelledName({}, ALICE, "   ", "aaaa…aaaa"), "aaaa…aaaa");
  assert.equal(labelledName({}, ALICE, null, "aaaa…aaaa"), "aaaa…aaaa");
});

test("isRenamed is true only when the label differs from what they published", () => {
  assert.equal(isRenamed({ [ALICE]: "Ada" }, ALICE, "alice"), true);
  assert.equal(isRenamed({ [ALICE]: "alice" }, ALICE, "alice"), false);
  assert.equal(isRenamed({}, ALICE, "alice"), false);
});

test("labels round-trip through storage", () => {
  const storage = memoryStorage();
  writeUserLabels(storage, { [ALICE]: "Ada" });
  assert.deepEqual(readUserLabels(storage), { [ALICE]: "Ada" });
  writeUserLabels(storage, {});
  assert.deepEqual(readUserLabels(storage), {});
});

test("corrupt or hostile stored labels degrade to none", () => {
  assert.deepEqual(
    readUserLabels(memoryStorage({ [USER_LABELS_STORAGE_KEY]: "{oops" })),
    {},
  );
  assert.deepEqual(
    readUserLabels(memoryStorage({ [USER_LABELS_STORAGE_KEY]: "[]" })),
    {},
  );
  assert.deepEqual(
    readUserLabels(
      memoryStorage({
        [USER_LABELS_STORAGE_KEY]: JSON.stringify({
          [ALICE.toUpperCase()]: "  Ada  ",
          bad: 7,
          blank: "   ",
        }),
      }),
    ),
    { [ALICE]: "Ada" },
  );
  assert.deepEqual(readUserLabels(null), {});
});

test("a storage that throws never breaks a read or a write", () => {
  const hostile = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    },
  };
  assert.deepEqual(readUserLabels(hostile), {});
  assert.doesNotThrow(() => writeUserLabels(hostile, { [ALICE]: "Ada" }));
});
