import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dedupeNotes,
  deletedEventIds,
  likedTargets,
  noteFromEvent,
  orderByLikedAt,
  reactionTargetId,
  sortNotesNewestFirst,
  toFeed,
} from "./noteFeed.ts";

const ME = "aa".repeat(32);
const T = 1_800_000_000;

function note(id, createdAt, pubkey = ME) {
  return { id, pubkey, createdAt, content: id, tags: [] };
}

function reaction(id, createdAt, tags, pubkey = ME) {
  return {
    id,
    pubkey,
    kind: 7,
    created_at: createdAt,
    content: "+",
    tags,
    sig: "f".repeat(128),
  };
}

test("noteFromEvent normalises the wire shape", () => {
  const event = {
    id: "n1",
    pubkey: ME,
    kind: 1,
    created_at: T,
    content: "hello",
    tags: [["e", "root"]],
    sig: "f".repeat(128),
  };
  assert.deepEqual(noteFromEvent(event), {
    id: "n1",
    pubkey: ME,
    createdAt: T,
    content: "hello",
    tags: [["e", "root"]],
  });
});

test("sortNotesNewestFirst orders by created_at descending", () => {
  const sorted = sortNotesNewestFirst([
    note("old", T - 100),
    note("new", T),
    note("mid", T - 50),
  ]);
  assert.deepEqual(
    sorted.map((n) => n.id),
    ["new", "mid", "old"],
  );
});

test("sortNotesNewestFirst breaks a timestamp tie deterministically", () => {
  // An agent posting a burst stamps several notes in the same second. A
  // comparator returning 0 there leaves the order at the mercy of relay
  // delivery sequence, which differs between a stored replay and a live push.
  const forward = sortNotesNewestFirst([note("bbb", T), note("aaa", T)]);
  const reverse = sortNotesNewestFirst([note("aaa", T), note("bbb", T)]);
  assert.deepEqual(
    forward.map((n) => n.id),
    ["aaa", "bbb"],
  );
  assert.deepEqual(
    forward.map((n) => n.id),
    reverse.map((n) => n.id),
  );
});

test("sortNotesNewestFirst does not mutate its input", () => {
  const input = [note("a", T - 1), note("b", T)];
  sortNotesNewestFirst(input);
  assert.deepEqual(
    input.map((n) => n.id),
    ["a", "b"],
  );
});

test("dedupeNotes keeps the first occurrence of a repeated id", () => {
  const deduped = dedupeNotes([
    { ...note("n1", T), content: "live" },
    { ...note("n1", T), content: "replayed" },
    note("n2", T - 1),
  ]);
  assert.deepEqual(
    deduped.map((n) => n.id),
    ["n1", "n2"],
  );
  assert.equal(deduped[0].content, "live");
});

test("toFeed sorts then dedupes", () => {
  const feed = toFeed([note("a", T - 10), note("b", T), note("a", T - 10)]);
  assert.deepEqual(
    feed.map((n) => n.id),
    ["b", "a"],
  );
});

test("reactionTargetId takes the LAST e tag, per NIP-25", () => {
  // A reaction to a reply carries the thread root first and the reacted-to
  // event last; taking the first would like the wrong note.
  const target = reactionTargetId(
    reaction("r1", T, [
      ["e", "root-id"],
      ["e", "reply-id"],
    ]),
  );
  assert.equal(target, "reply-id");
});

test("reactionTargetId ignores non-e tags and returns null when absent", () => {
  assert.equal(
    reactionTargetId(
      reaction("r1", T, [
        ["p", "someone"],
        ["e", "the-one"],
        ["k", "1"],
      ]),
    ),
    "the-one",
  );
  assert.equal(reactionTargetId(reaction("r1", T, [["p", "someone"]])), null);
});

test("deletedEventIds collects every e tag across deletions", () => {
  const ids = deletedEventIds([
    reaction("d1", T, [
      ["e", "r1"],
      ["e", "r2"],
    ]),
    reaction("d2", T, [["e", "r3"]]),
  ]);
  assert.deepEqual([...ids].sort(), ["r1", "r2", "r3"]);
});

test("likedTargets resolves reactions to targets, newest like first", () => {
  const { ids, likedAt } = likedTargets(
    [
      reaction("r-old", T - 100, [["e", "note-old"]]),
      reaction("r-new", T, [["e", "note-new"]]),
    ],
    [],
    10,
  );
  assert.deepEqual(ids, ["note-new", "note-old"]);
  assert.equal(likedAt.get("note-new"), T);
  assert.equal(likedAt.get("note-old"), T - 100);
});

test("likedTargets drops a reaction retracted by a kind:5", () => {
  // Un-liking is a deletion of the reaction, not a second reaction. Skipping
  // this leaves un-liked notes on the Liked tab forever.
  const { ids } = likedTargets(
    [
      reaction("r-kept", T, [["e", "note-kept"]]),
      reaction("r-gone", T - 1, [["e", "note-gone"]]),
    ],
    [reaction("del", T + 1, [["e", "r-gone"]])],
    10,
  );
  assert.deepEqual(ids, ["note-kept"]);
});

test("likedTargets keeps only the newest reaction per target", () => {
  const { ids, likedAt } = likedTargets(
    [
      reaction("r1", T - 500, [["e", "same-note"]]),
      reaction("r2", T, [["e", "same-note"]]),
    ],
    [],
    10,
  );
  assert.deepEqual(ids, ["same-note"]);
  assert.equal(likedAt.get("same-note"), T);
});

test("likedTargets honours the cap", () => {
  const reactions = [];
  for (let index = 0; index < 10; index += 1) {
    reactions.push(reaction(`r${index}`, T - index, [["e", `n${index}`]]));
  }
  const { ids } = likedTargets(reactions, [], 3);
  assert.deepEqual(ids, ["n0", "n1", "n2"]);
});

test("likedTargets skips a reaction with no target", () => {
  const { ids } = likedTargets(
    [
      reaction("r1", T, [["p", "nobody"]]),
      reaction("r2", T - 1, [["e", "real"]]),
    ],
    [],
    10,
  );
  assert.deepEqual(ids, ["real"]);
});

test("orderByLikedAt re-sorts relay order into like order", () => {
  // The kind:1 fetch comes back in relay order, which has nothing to do with
  // when the viewer liked them.
  const likedAt = new Map([
    ["a", T - 100],
    ["b", T],
  ]);
  const ordered = orderByLikedAt([note("a", 1), note("b", 2)], likedAt);
  assert.deepEqual(
    ordered.map((n) => n.id),
    ["b", "a"],
  );
});

test("orderByLikedAt puts an unknown note last rather than dropping it", () => {
  const ordered = orderByLikedAt(
    [note("unknown", 1), note("known", 2)],
    new Map([["known", T]]),
  );
  assert.deepEqual(
    ordered.map((n) => n.id),
    ["known", "unknown"],
  );
});
