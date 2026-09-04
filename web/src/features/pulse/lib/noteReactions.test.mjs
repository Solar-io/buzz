import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyReactionState,
  foldReactions,
  isDuplicateReactionError,
  UPVOTE_EMOJI,
} from "./noteReactions.ts";

const ME = "aa".repeat(32);
const ALICE = "bb".repeat(32);
const BOB = "cc".repeat(32);
const T = 1_800_000_000;

function reaction(id, pubkey, targetId, content = UPVOTE_EMOJI) {
  return {
    id,
    pubkey,
    kind: 7,
    created_at: T,
    content,
    tags: [["e", targetId]],
    sig: "f".repeat(128),
  };
}

function deletion(id, reactionId, pubkey = ME) {
  return {
    id,
    pubkey,
    kind: 5,
    created_at: T + 1,
    content: "",
    tags: [["e", reactionId]],
    sig: "f".repeat(128),
  };
}

test("foldReactions counts distinct reactors per note", () => {
  const state = foldReactions(
    [
      reaction("r1", ALICE, "n1"),
      reaction("r2", BOB, "n1"),
      reaction("r3", ALICE, "n2"),
    ],
    [],
    ME,
  );
  assert.equal(state.get("n1").count, 2);
  assert.equal(state.get("n2").count, 1);
});

test("foldReactions counts one reactor once even on a duplicate publish", () => {
  const state = foldReactions(
    [reaction("r1", ALICE, "n1"), reaction("r2", ALICE, "n1")],
    [],
    ME,
  );
  assert.equal(state.get("n1").count, 1);
});

test("foldReactions marks the viewer's own reaction", () => {
  const state = foldReactions(
    [reaction("r1", ME, "mine"), reaction("r2", ALICE, "theirs")],
    [],
    ME,
  );
  assert.equal(state.get("mine").reactedByCurrentUser, true);
  assert.equal(state.get("theirs").reactedByCurrentUser, false);
});

test("foldReactions with no viewer never claims a reaction is theirs", () => {
  const state = foldReactions([reaction("r1", ALICE, "n1")], [], null);
  assert.equal(state.get("n1").reactedByCurrentUser, false);
});

test("foldReactions ignores every emoji but +", () => {
  // Pulse's heart is the NIP-25 `+` upvote. A 🔥 on the same note is a
  // channel-style reaction and must not inflate the like count.
  const state = foldReactions(
    [
      reaction("r1", ALICE, "n1", "🔥"),
      reaction("r2", BOB, "n1", "+"),
      reaction("r3", ME, "n1", "❤️"),
    ],
    [],
    ME,
  );
  assert.equal(state.get("n1").count, 1);
  assert.equal(
    state.get("n1").reactedByCurrentUser,
    false,
    "a ❤️ from the viewer is not an upvote",
  );
});

test("a retracted reaction is not counted", () => {
  const state = foldReactions(
    [reaction("r1", ALICE, "n1"), reaction("r2", BOB, "n1")],
    [deletion("d1", "r2")],
    ME,
  );
  assert.equal(state.get("n1").count, 1);
});

test("retracting the viewer's own reaction clears the filled heart", () => {
  // Without the kind:5 pass the heart stays filled after an un-like until the
  // next reload — the most visible way this could be wrong.
  const state = foldReactions(
    [reaction("r-mine", ME, "n1")],
    [deletion("d1", "r-mine")],
    ME,
  );
  assert.equal(state.has("n1"), false);
});

test("a note with no reactions is absent from the map", () => {
  const state = foldReactions([], [], ME);
  assert.equal(state.size, 0);
});

test("applyReactionState adds one on a fresh upvote", () => {
  const next = applyReactionState(undefined, "n1", true);
  assert.deepEqual(next.get("n1"), { count: 1, reactedByCurrentUser: true });
});

test("applyReactionState removes one on an un-upvote", () => {
  const before = new Map([["n1", { count: 3, reactedByCurrentUser: true }]]);
  assert.deepEqual(applyReactionState(before, "n1", false).get("n1"), {
    count: 2,
    reactedByCurrentUser: false,
  });
});

test("applyReactionState does not double-count a repeated upvote", () => {
  const before = new Map([["n1", { count: 1, reactedByCurrentUser: true }]]);
  assert.equal(applyReactionState(before, "n1", true).get("n1").count, 1);
});

test("applyReactionState floors the count at zero", () => {
  // Retracting against state the relay never confirmed must not go negative.
  const before = new Map([["n1", { count: 0, reactedByCurrentUser: true }]]);
  assert.equal(applyReactionState(before, "n1", false).get("n1").count, 0);
});

test("applyReactionState leaves other notes and the input map alone", () => {
  const before = new Map([
    ["n1", { count: 1, reactedByCurrentUser: false }],
    ["n2", { count: 5, reactedByCurrentUser: true }],
  ]);
  const next = applyReactionState(before, "n1", true);
  assert.deepEqual(next.get("n2"), { count: 5, reactedByCurrentUser: true });
  assert.equal(before.get("n1").count, 1, "the input map is not mutated");
});

test("isDuplicateReactionError recognises the relay's no-op rejection", () => {
  assert.equal(
    isDuplicateReactionError(new Error("duplicate: reaction already exists")),
    true,
  );
  assert.equal(
    isDuplicateReactionError("DUPLICATE: Reaction Already Exists"),
    true,
  );
});

test("isDuplicateReactionError does not swallow a real failure", () => {
  assert.equal(isDuplicateReactionError(new Error("rate-limited")), false);
  assert.equal(isDuplicateReactionError(null), false);
  assert.equal(isDuplicateReactionError(undefined), false);
  assert.equal(isDuplicateReactionError({ message: "duplicate" }), false);
});
