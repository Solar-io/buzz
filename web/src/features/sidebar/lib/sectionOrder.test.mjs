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

test("unread first, then most used within each group", () => {
  const items = [
    item("quiet", { score: 0.2 }),
    item("busy", { score: 9 }),
    item("unreadRare", { unread: true, score: 0.1 }),
    item("unreadHot", { unread: true, score: 4 }),
    item("mid", { score: 3 }),
  ];
  assert.deepEqual(keys(rankSection(items, keyOf, factsOf)), [
    "unreadHot",
    "unreadRare",
    "busy",
    "mid",
    "quiet",
  ]);
});

test("equal usage breaks by newest activity, then name, then key", () => {
  const items = [
    item("b-old", { score: 1, lastActivity: 100, name: "beta" }),
    item("a-new", { score: 1, lastActivity: 200, name: "zeta" }),
    item("c", { score: 1, lastActivity: 100, name: "Alpha" }),
    item("d2", { score: 1, lastActivity: 100, name: "beta" }),
  ];
  assert.deepEqual(keys(rankSection(items, keyOf, factsOf)), [
    "a-new",
    "c",
    "b-old",
    "d2",
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
