import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readWatermark,
  watermarkStorageKey,
  writeWatermark,
} from "./dueWatermark.ts";
import { dueSince } from "./reminderFilters.ts";

const PUBKEY = "AA".repeat(32);
const NOW = 1_800_000_000;

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
  };
}

test("the storage key is per-key and case-insensitive", () => {
  assert.equal(
    watermarkStorageKey(PUBKEY),
    watermarkStorageKey(PUBKEY.toLowerCase()),
  );
  assert.equal(watermarkStorageKey(` ${PUBKEY} `), watermarkStorageKey(PUBKEY));
  assert.notEqual(
    watermarkStorageKey(PUBKEY),
    watermarkStorageKey("bb".repeat(32)),
  );
});

test("a first read seeds the watermark to now and persists it", () => {
  const storage = fakeStorage();
  assert.equal(readWatermark(storage, PUBKEY, NOW), NOW);
  assert.equal(storage.getItem(watermarkStorageKey(PUBKEY)), String(NOW));
});

test("a seeded watermark makes an already-overdue reminder fire nothing", () => {
  // The whole reason the seed is `now` and not 0: a fresh device must not
  // replay the user's reminder history as alerts.
  const storage = fakeStorage();
  const watermark = readWatermark(storage, PUBKEY, NOW);
  const ancient = {
    id: "d1",
    notBefore: NOW - 604_800,
    createdAt: 1,
    eventId: "e1",
    content: { status: "pending", note: "old" },
  };
  assert.deepEqual(dueSince([ancient], watermark, NOW), []);
});

test("a later read returns the stored value, not a fresh seed", () => {
  const storage = fakeStorage({ [watermarkStorageKey(PUBKEY)]: "1700000000" });
  assert.equal(readWatermark(storage, PUBKEY, NOW), 1_700_000_000);
});

test("a corrupt stored value is re-seeded rather than becoming NaN", () => {
  // Number("") is 0 and Number("nope") is NaN; every comparison against NaN
  // is false, which would silently disable firing forever.
  const storage = fakeStorage({ [watermarkStorageKey(PUBKEY)]: "nope" });
  assert.equal(readWatermark(storage, PUBKEY, NOW), NOW);
  assert.equal(storage.getItem(watermarkStorageKey(PUBKEY)), String(NOW));
});

test("writeWatermark advances the stored value", () => {
  const storage = fakeStorage();
  writeWatermark(storage, PUBKEY, NOW + 60);
  assert.equal(readWatermark(storage, PUBKEY, NOW), NOW + 60);
});

test("two keys keep independent watermarks", () => {
  const storage = fakeStorage();
  const other = "cc".repeat(32);
  writeWatermark(storage, PUBKEY, 111);
  writeWatermark(storage, other, 222);
  assert.equal(readWatermark(storage, PUBKEY, NOW), 111);
  assert.equal(readWatermark(storage, other, NOW), 222);
});

test("a reminder due between two checks fires exactly once", () => {
  const storage = fakeStorage();
  const reminder = {
    id: "d1",
    notBefore: NOW + 30,
    createdAt: 1,
    eventId: "e1",
    content: { status: "pending", note: "soon" },
  };

  // Check 1, before it is due: nothing fires, watermark advances.
  const first = readWatermark(storage, PUBKEY, NOW);
  assert.deepEqual(dueSince([reminder], first, NOW), []);
  writeWatermark(storage, PUBKEY, NOW);

  // Check 2, after it is due: it fires.
  const second = readWatermark(storage, PUBKEY, NOW + 60);
  assert.deepEqual(
    dueSince([reminder], second, NOW + 60).map((r) => r.id),
    ["d1"],
  );
  writeWatermark(storage, PUBKEY, NOW + 60);

  // Check 3, later still: it does NOT fire again.
  const third = readWatermark(storage, PUBKEY, NOW + 120);
  assert.deepEqual(dueSince([reminder], third, NOW + 120), []);
});
