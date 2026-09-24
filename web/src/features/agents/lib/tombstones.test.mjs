import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitAfterTombstone,
  applyTombstone,
  withoutKey,
} from "./tombstones.ts";

test("forget then an older or equal version is refused, a newer one admitted", () => {
  const tombstones = applyTombstone(new Map(), "p1", 500);
  assert.equal(admitAfterTombstone(tombstones, "p1", 499), false);
  assert.equal(admitAfterTombstone(tombstones, "p1", 500), false);
  assert.equal(admitAfterTombstone(tombstones, "p1", 501), true);
  assert.equal(admitAfterTombstone(tombstones, "other", 1), true);
});

test("applyTombstone keeps the latest created_at and never mutates its input", () => {
  const first = applyTombstone(new Map(), "p1", 500);
  const second = applyTombstone(first, "p1", 400);
  assert.equal(second.get("p1"), 500);
  assert.equal(applyTombstone(second, "p1", 600).get("p1"), 600);
  assert.equal(first.get("p1"), 500);
});

test("withoutKey removes only the id", () => {
  const map = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  assert.deepEqual([...withoutKey(map, "a").keys()], ["b"]);
  assert.equal(map.size, 2);
});
