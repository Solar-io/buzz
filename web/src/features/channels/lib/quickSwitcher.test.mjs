import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeQuickQuery, rankQuickTargets } from "./quickSwitcher.ts";

/**
 * Ordering is the whole product here: a switcher that returns the right set in
 * the wrong order is worse than useless, because the top row is what Enter
 * selects. Every vector below therefore asserts a *specific* winner, not
 * merely that a match was found.
 */

const CHANNELS = [
  { id: "c-design", kind: "channel", label: "design", weight: 1 },
  { id: "c-dev", kind: "channel", label: "dev", weight: 2 },
  { id: "c-random", kind: "channel", label: "random", weight: 3 },
  { id: "c-redesign", kind: "channel", label: "redesign", weight: 9 },
];

test("an exact match outranks a prefix match", () => {
  // "dev" is a prefix of nothing else here, but "design" also starts with
  // "de" — the exact hit must win regardless of its lower weight.
  const [top] = rankQuickTargets("dev", CHANNELS);
  assert.equal(top.id, "c-dev");
});

test("a prefix match outranks a mid-word substring, even at higher weight", () => {
  // "redesign" carries weight 9 (most recent) and contains "design", but
  // "design" is a prefix match. This is the case a naive recency sort gets
  // wrong, so it is the one worth pinning.
  const results = rankQuickTargets("design", CHANNELS);
  assert.equal(results[0].id, "c-design");
  assert.equal(results[1].id, "c-redesign");
});

test("weight breaks ties between equally-good matches", () => {
  const candidates = [
    { id: "a", kind: "channel", label: "alpha", weight: 1 },
    { id: "b", kind: "channel", label: "alpine", weight: 5 },
  ];
  // Both are prefix matches on "alp"; recency decides.
  const results = rankQuickTargets("alp", candidates);
  assert.equal(results[0].id, "b");
  assert.equal(results[1].id, "a");
});

test("weight can never promote a substring hit over a prefix hit", () => {
  // The clamp exists for exactly this: an old channel whose name starts with
  // the query must still beat a very recent one that merely contains it.
  const candidates = [
    { id: "prefix", kind: "channel", label: "opsec", weight: 0 },
    { id: "substr", kind: "channel", label: "devops-notes", weight: 9999 },
  ];
  const results = rankQuickTargets("ops", candidates);
  assert.equal(results[0].id, "prefix");
});

test("word-boundary matches beat mid-word ones", () => {
  const candidates = [
    { id: "mid", kind: "channel", label: "codesign", weight: 0 },
    { id: "word", kind: "channel", label: "buzz design", weight: 0 },
  ];
  const results = rankQuickTargets("des", candidates);
  assert.equal(results[0].id, "word");
});

test("keywords widen matching beyond the label", () => {
  const candidates = [
    {
      id: "act-new-dm",
      kind: "action",
      label: "New message",
      keywords: ["dm", "direct"],
    },
  ];
  assert.equal(rankQuickTargets("dm", candidates).length, 1);
  assert.equal(rankQuickTargets("direct", candidates)[0].id, "act-new-dm");
});

test("a non-matching query returns nothing rather than everything", () => {
  // The failure mode worth guarding: a scorer that returns a floor value
  // makes every candidate a "match" and the palette becomes noise.
  assert.deepEqual(rankQuickTargets("zzzznotathing", CHANNELS), []);
});

test("an empty query returns the highest-weight candidates in order", () => {
  // This is the pre-typing list, so Enter on an unfiltered palette must land
  // on the most recent conversation.
  const results = rankQuickTargets("", CHANNELS);
  assert.deepEqual(
    results.map((r) => r.id),
    ["c-redesign", "c-random", "c-dev", "c-design"],
  );
});

test("the limit is respected", () => {
  const results = rankQuickTargets("", CHANNELS, 2);
  assert.equal(results.length, 2);
});

test("matching is case-insensitive in both directions", () => {
  const candidates = [{ id: "x", kind: "channel", label: "DesignOps" }];
  assert.equal(rankQuickTargets("designops", candidates).length, 1);
  assert.equal(rankQuickTargets("DESIGNOPS", candidates).length, 1);
});

test("kind and hint survive ranking", () => {
  const candidates = [
    { id: "d1", kind: "dm", label: "Alice", hint: "Direct message" },
  ];
  const [top] = rankQuickTargets("ali", candidates);
  assert.equal(top.kind, "dm");
  assert.equal(top.hint, "Direct message");
});

test("normalizeQuickQuery strips a leading channel or mention sigil", () => {
  assert.equal(normalizeQuickQuery("#design"), "design");
  assert.equal(normalizeQuickQuery("@alice"), "alice");
  assert.equal(normalizeQuickQuery("design"), "design");
  // Only the leading one — an interior # is part of the text.
  assert.equal(normalizeQuickQuery("a#b"), "a#b");
});
