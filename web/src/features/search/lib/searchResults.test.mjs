import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assembleSearchResults,
  clampSelection,
  moveSelection,
  scoreChannelMatch,
  scorePersonMatch,
  searchResultKey,
} from "./searchResults.ts";
import {
  RECENT_SEARCHES_MAX,
  forgetSearch,
  readRecentSearches,
  rememberSearch,
  writeRecentSearches,
} from "./recentSearches.ts";

const HIT = {
  id: "e1",
  channelId: "c1",
  authorPubkey: "a".repeat(64),
  createdAt: 1,
  content: "hi",
};

test("sections are assembled in a fixed order", () => {
  const results = assembleSearchResults({
    messages: [{ kind: "message", hit: HIT }],
    people: [{ kind: "person", pubkey: "p", label: "P" }],
    channels: [{ kind: "channel", id: "c", label: "C" }],
    actions: [{ kind: "action", id: "a", label: "A" }],
  });
  assert.deepEqual(
    results.map((result) => result.kind),
    ["action", "channel", "person", "message"],
  );
});

test("every result kind produces a distinct key", () => {
  const keys = [
    searchResultKey({ kind: "action", id: "x", label: "" }),
    searchResultKey({ kind: "channel", id: "x", label: "" }),
    searchResultKey({ kind: "person", pubkey: "x", label: "" }),
    searchResultKey({ kind: "message", hit: { ...HIT, id: "x" } }),
  ];
  assert.equal(new Set(keys).size, 4, `keys collided: ${keys.join()}`);
});

test("selection wraps at both ends", () => {
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(
    moveSelection(2, 1, 3),
    0,
    "down at the bottom wraps to the top",
  );
  assert.equal(moveSelection(0, -1, 3), 2, "up at the top wraps to the bottom");
});

test("selection is safe against an empty list", () => {
  assert.equal(moveSelection(5, 1, 0), 0);
  assert.equal(clampSelection(5, 0), 0);
});

test("a shrinking list pulls the selection back into range", () => {
  assert.equal(clampSelection(9, 3), 2);
  assert.equal(clampSelection(1, 3), 1);
  assert.equal(clampSelection(-4, 3), 0);
});

test("channel ranking prefers exact, then prefix, then substring", () => {
  assert.equal(scoreChannelMatch({ name: "dev" }, "dev"), 0);
  assert.equal(scoreChannelMatch({ name: "developers" }, "dev"), 1);
  assert.equal(scoreChannelMatch({ name: "web-dev" }, "dev"), 2);
  assert.equal(
    scoreChannelMatch({ name: "random", about: "dev talk" }, "dev"),
    3,
  );
  assert.equal(scoreChannelMatch({ name: "random" }, "dev"), null);
  assert.equal(scoreChannelMatch({ name: "dev" }, "  "), null);
});

test("a shorter exact name outranks a longer prefix match", () => {
  const exact = scoreChannelMatch({ name: "dev" }, "dev");
  const prefix = scoreChannelMatch({ name: "developers" }, "dev");
  assert.ok(exact < prefix);
});

test("people rank by display name, falling back to a pubkey prefix", () => {
  const person = { pubkey: `abcd${"0".repeat(60)}`, displayName: "Ada" };
  assert.equal(scorePersonMatch(person, "ada"), 0);
  assert.equal(scorePersonMatch(person, "ad"), 1);
  assert.equal(scorePersonMatch(person, "da"), 2);
  assert.equal(scorePersonMatch(person, "abcd"), 3);
  assert.equal(scorePersonMatch(person, "zzz"), null);
});

test("a person with no name still matches on their key", () => {
  const anon = { pubkey: `beef${"0".repeat(60)}`, displayName: null };
  assert.equal(scorePersonMatch(anon, "beef"), 3);
  assert.equal(scorePersonMatch(anon, "nope"), null);
});

test("recent searches are most-recent-first and de-duplicated", () => {
  let recent = rememberSearch([], "deploy");
  recent = rememberSearch(recent, "rollback");
  recent = rememberSearch(recent, "DEPLOY");
  // The new casing wins — it is what the user just typed.
  assert.deepEqual(recent, ["DEPLOY", "rollback"]);
});

test("recent searches are capped", () => {
  let recent = [];
  for (let index = 0; index < RECENT_SEARCHES_MAX + 5; index += 1) {
    recent = rememberSearch(recent, `q${index}`);
  }
  assert.equal(recent.length, RECENT_SEARCHES_MAX);
  assert.equal(recent[0], `q${RECENT_SEARCHES_MAX + 4}`);
});

test("an empty query is not remembered", () => {
  assert.deepEqual(rememberSearch(["a"], "   "), ["a"]);
});

test("a recent search can be forgotten", () => {
  assert.deepEqual(forgetSearch(["a", "B"], "b"), ["a"]);
});

test("recent searches round-trip through storage and survive junk", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  writeRecentSearches(storage, ["deploy", "rollback"]);
  assert.deepEqual(readRecentSearches(storage), ["deploy", "rollback"]);

  writeRecentSearches(storage, []);
  assert.deepEqual(readRecentSearches(storage), []);

  store.set("buzz:recent-searches.v1", "{not json");
  assert.deepEqual(readRecentSearches(storage), []);
  store.set("buzz:recent-searches.v1", JSON.stringify(["ok", 7, "  "]));
  assert.deepEqual(readRecentSearches(storage), ["ok"]);
  assert.deepEqual(readRecentSearches(null), []);
});
