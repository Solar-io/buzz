import assert from "node:assert/strict";
import { test } from "node:test";
import {
  excerpt,
  searchFilter,
  searchHitFromEvent,
  sortHits,
} from "./search.ts";

function event(overrides = {}) {
  return {
    kind: 9,
    created_at: 1_787_800_000,
    tags: [["h", "chan-1"]],
    content: "hello world",
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    ...overrides,
  };
}

test("searchFilter builds scoped and unscoped shapes", () => {
  const all = searchFilter("btc dip", "all", "chan-1");
  assert.equal(all.search, "btc dip");
  assert.equal(all["#h"], undefined, "all-scope has no h constraint");
  assert.deepEqual(all.kinds, [9, 40002, 40008, 45001, 45003]);

  const scoped = searchFilter("btc", "channel", "chan-1");
  assert.deepEqual(scoped["#h"], ["chan-1"]);

  // Too-short and whitespace-only queries never reach the relay.
  assert.equal(searchFilter("b", "all", null), null);
  assert.equal(searchFilter("   ", "all", null), null);
  // Channel scope without a channel id cannot constrain — degrade to all.
  assert.equal(searchFilter("btc", "channel", null)["#h"], undefined);
});

test("searchHitFromEvent reads the h tag and rejects h-less events", () => {
  const hit = searchHitFromEvent(
    event({ id: "f".repeat(64), content: "found it" }),
  );
  assert.equal(hit.id, "f".repeat(64));
  assert.equal(hit.channelId, "chan-1");
  assert.equal(searchHitFromEvent(event({ tags: [] })), null);
});

test("sortHits orders newest first without mutating input", () => {
  const older = {
    id: "a",
    channelId: "c",
    authorPubkey: "p",
    createdAt: 100,
    content: "",
  };
  const newer = {
    id: "b",
    channelId: "c",
    authorPubkey: "p",
    createdAt: 200,
    content: "",
  };
  const input = [older, newer];
  assert.deepEqual(
    sortHits(input).map((h) => h.id),
    ["b", "a"],
  );
  assert.deepEqual(
    input.map((h) => h.id),
    ["a", "b"],
    "input untouched",
  );
});

test("excerpt centers the match and collapses whitespace", () => {
  const content = `${"x".repeat(80)} needle ${"y".repeat(80)}`;
  const out = excerpt(content, "needle");
  assert.ok(out.startsWith("…"), "leading context is elided");
  assert.ok(out.endsWith("…"), "trailing context is elided");
  assert.ok(out.includes("needle"), "the match itself is present");
  assert.ok(out.length < content.length, "shorter than the source");

  assert.equal(excerpt("one\ntwo  three", "three"), "one two three");
  // No match: leading slice, not a crash.
  assert.equal(excerpt("short message", "zzz"), "short message");
  const long = `${"z".repeat(200)}`;
  assert.ok(excerpt(long, "").endsWith("…"), "queryless excerpt truncates");
});
