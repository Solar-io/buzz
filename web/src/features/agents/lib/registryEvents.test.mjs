import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRegistryEvent } from "./registryEvents.ts";

const owner = "a".repeat(64);
const key = "b".repeat(64);
const empty = () => ({ registry: new Map(), tombstones: new Map() });
const head = (at = 10) => ({
  kind: 30177,
  pubkey: owner,
  created_at: at,
  tags: [["d", key]],
  content: '{"name":"Throwaway"}',
});
const deletion = (
  at = 20,
  author = owner,
  coordinate = `30177:${owner}:${key}`,
) => ({
  kind: 5,
  pubkey: author,
  created_at: at,
  tags: [["a", coordinate]],
  content: "",
});

test("desktop unregister tombstone removes the row and blocks late head replay", () => {
  const populated = applyRegistryEvent(empty(), head(), owner);
  assert.equal(populated.registry.size, 1);
  const removed = applyRegistryEvent(populated, deletion(), owner);
  assert.equal(removed.registry.size, 0);
  assert.equal(applyRegistryEvent(removed, head(), owner).registry.size, 0);
  assert.equal(applyRegistryEvent(removed, head(20), owner).registry.size, 0);
  assert.equal(applyRegistryEvent(removed, head(21), owner).registry.size, 1);
});
test("a tombstone received before its head prevents registration resurrection", () => {
  const removed = applyRegistryEvent(empty(), deletion(), owner);
  assert.equal(applyRegistryEvent(removed, head(), owner).registry.size, 0);
});
test("a stale deletion cannot remove a newer recreated registration", () => {
  const recreated = applyRegistryEvent(empty(), head(30), owner);
  assert.equal(
    applyRegistryEvent(recreated, deletion(), owner).registry.get(key)
      .updatedAt,
    30,
  );
});
test("foreign authors, foreign coordinates and malformed tombstones cannot remove owner rows", () => {
  const populated = applyRegistryEvent(empty(), head(), owner);
  for (const event of [
    deletion(20, key),
    deletion(20, owner, `30177:${key}:${key}`),
    deletion(20, owner, `30175:${owner}:${key}`),
    deletion(20, owner, `30177:${owner}:invalid`),
    { ...head(40), pubkey: key },
  ]) {
    assert.equal(applyRegistryEvent(populated, event, owner).registry.size, 1);
  }
});
