import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reactionFromEvent,
  upsertReaction,
  reactionGroups,
  QUICK_REACTIONS,
} from "./reactions.ts";

function reactionEvent(emoji, targetId, pubkey) {
  return {
    kind: 7,
    content: emoji,
    pubkey,
    tags: [["e", targetId]],
    id: "r".repeat(62) + pubkey.slice(0, 2),
    created_at: 1000,
    sig: "f".repeat(128),
  };
}

test("reactionFromEvent reads target from e tag and emoji from content", () => {
  const parsed = reactionFromEvent(reactionEvent("🔥", "abc", "aa".repeat(32)));
  assert.deepEqual(parsed, { targetId: "abc", emoji: "🔥" });
  assert.equal(reactionFromEvent({ kind: 9, content: "x" }), null);
});

test("upsertReaction dedupes the same author per emoji", () => {
  const author = "aa".repeat(32);
  let index = upsertReaction(
    new Map(),
    { targetId: "t1", emoji: "👍" },
    author,
  );
  index = upsertReaction(index, { targetId: "t1", emoji: "👍" }, author);
  assert.equal(reactionGroups(index, "t1")[0].pubkeys.length, 1);
});

test("reactionGroups sorts most-reacted first", () => {
  let index = new Map();
  index = upsertReaction(
    index,
    { targetId: "t", emoji: "👍" },
    "aa".repeat(32),
  );
  index = upsertReaction(
    index,
    { targetId: "t", emoji: "👍" },
    "bb".repeat(32),
  );
  index = upsertReaction(
    index,
    { targetId: "t", emoji: "🔥" },
    "cc".repeat(32),
  );
  const groups = reactionGroups(index, "t");
  assert.equal(groups[0].emoji, "👍");
  assert.equal(groups[0].pubkeys.length, 2);
  assert.equal(groups[1].emoji, "🔥");
});

test("quick reactions are single-grapheme emoji", () => {
  for (const emoji of QUICK_REACTIONS) {
    assert.ok([...emoji].length <= 2, emoji);
  }
});
