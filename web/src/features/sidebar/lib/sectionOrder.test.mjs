import assert from "node:assert/strict";
import { test } from "node:test";
import { holdOrder, rankSection } from "./sectionOrder.ts";

// Items carry their own facts; expectations are hardcoded key orders.
const item = (
  key,
  { unread = false, score = 0, lastActivity = 0, name = key } = {},
) => ({
  key,
  facts: { unread, score, lastActivity, name },
});
const keyOf = (i) => i.key;
const factsOf = (i) => i.facts;
const keys = (items) => items.map(keyOf);

test("unread by recency, then the four most used, then A-Z", () => {
  const items = [
    item("zulu", { score: 0.2 }),
    item("busy", { score: 9 }),
    item("unreadOldHot", { unread: true, score: 40, lastActivity: 100 }),
    item("unreadNewRare", { unread: true, score: 0.1, lastActivity: 300 }),
    item("mid", { score: 3 }),
    item("low", { score: 1 }),
    item("lower", { score: 0.5 }),
    item("fifth", { score: 0.3 }),
    item("alpha"),
    item("charlie"),
  ];
  assert.deepEqual(keys(rankSection(items, keyOf, factsOf)), [
    // 1. unread, most recent first — usage does not reorder them
    "unreadNewRare",
    "unreadOldHot",
    // 2. the four highest visit scores among the read rows
    "busy",
    "mid",
    "low",
    "lower",
    // 3. everything else alphabetically, regardless of score
    "alpha",
    "charlie",
    "fifth",
    "zulu",
  ]);
});

test("never-visited rows do not take a frequent slot", () => {
  const items = [
    item("zed"),
    item("used", { score: 2, name: "yankee" }),
    item("apple"),
  ];
  assert.deepEqual(keys(rankSection(items, keyOf, factsOf)), [
    "used",
    "apple",
    "zed",
  ]);
});

test("ties break by name case-insensitively, then key", () => {
  const items = [
    item("b-new", { unread: true, lastActivity: 100, name: "beta" }),
    item("c", { unread: true, lastActivity: 100, name: "Alpha" }),
    item("a-new", { unread: true, lastActivity: 200, name: "zeta" }),
    item("d2", { score: 1, name: "beta" }),
    item("d1", { score: 1, name: "Beta" }),
    item("e", { name: "Echo" }),
    item("f", { name: "delta" }),
  ];
  assert.deepEqual(keys(rankSection(items, keyOf, factsOf)), [
    "a-new",
    "c",
    "b-new",
    "d1",
    "d2",
    "f",
    "e",
  ]);
});

test("the result is a fresh array; the input keeps its order", () => {
  const items = [item("a"), item("b", { unread: true })];
  const ranked = rankSection(items, keyOf, factsOf);
  assert.deepEqual(keys(items), ["a", "b"]);
  assert.notEqual(ranked, items);
});

test("the open item ranks by its frozen facts, not its live ones", () => {
  // `opened` was unread and rarely used when clicked; live it is now read
  // with a bumped score — it must stay at the top until navigation away.
  const items = [
    item("other", { unread: true, score: 1 }),
    item("opened", { unread: false, score: 50 }),
    item("rest", { score: 2 }),
  ];
  const frozen = {
    key: "opened",
    facts: { unread: true, score: 5, lastActivity: 0, name: "opened" },
  };
  assert.deepEqual(keys(rankSection(items, keyOf, factsOf, { frozen })), [
    "opened",
    "other",
    "rest",
  ]);
  // Without the snapshot it would sit below the unread row.
  assert.deepEqual(keys(rankSection(items, keyOf, factsOf)), [
    "other",
    "opened",
    "rest",
  ]);
});

test("holdOrder keeps the held order, appends new items, drops gone ones", () => {
  const live = [item("new"), item("c"), item("a")];
  assert.deepEqual(keys(holdOrder(live, keyOf, ["a", "b", "c"])), [
    "a",
    "c",
    "new",
  ]);
});
