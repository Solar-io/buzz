import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReactionDeleteTemplate,
  describeReactors,
  ownReactionFilter,
  pickOwnReactionEventId,
  QUICK_REACTIONS,
  reactionFromEvent,
  reactionGroups,
  REACTION_DELETE_KIND,
  REACTION_KIND,
  removeReaction,
  upsertReaction,
} from "./reactions.ts";

const ME = "aa".repeat(32);
const ALICE = "bb".repeat(32);
const BOB = "cc".repeat(32);

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
  const parsed = reactionFromEvent(reactionEvent("🔥", "abc", ALICE));
  assert.deepEqual(parsed, { targetId: "abc", emoji: "🔥" });
  assert.equal(reactionFromEvent({ kind: 9, content: "x" }), null);
});

test("upsertReaction dedupes the same author per emoji", () => {
  let index = upsertReaction(new Map(), { targetId: "t1", emoji: "👍" }, ME);
  index = upsertReaction(index, { targetId: "t1", emoji: "👍" }, ME);
  assert.equal(reactionGroups(index, "t1")[0].pubkeys.length, 1);
});

test("reactionGroups sorts most-reacted first", () => {
  let index = new Map();
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ME);
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ALICE);
  index = upsertReaction(index, { targetId: "t", emoji: "🔥" }, BOB);
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

// ── self-state ──────────────────────────────────────────────────────────────

test("reactionGroups marks the viewer's own emoji pressed and others not", () => {
  let index = new Map();
  // The viewer is in 👍 only. 🔥 has TWO other reactors so the two groups
  // differ in every observable except the flag under test.
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ME);
  index = upsertReaction(index, { targetId: "t", emoji: "🔥" }, ALICE);
  index = upsertReaction(index, { targetId: "t", emoji: "🔥" }, BOB);
  const groups = reactionGroups(index, "t", ME);
  const mine = groups.find((group) => group.emoji === "👍");
  const theirs = groups.find((group) => group.emoji === "🔥");
  assert.equal(mine.reactedByCurrentUser, true);
  assert.equal(theirs.reactedByCurrentUser, false);
});

test("reactionGroups leaves every group unpressed without a viewer pubkey", () => {
  const index = upsertReaction(new Map(), { targetId: "t", emoji: "👍" }, ME);
  for (const selfPubkey of [undefined, null, ""]) {
    const [group] = reactionGroups(index, "t", selfPubkey);
    assert.equal(group.reactedByCurrentUser, false, String(selfPubkey));
  }
});

test("describeReactors names the viewer first as You", () => {
  let index = new Map();
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ALICE);
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ME);
  const [group] = reactionGroups(index, "t", ME);
  const names = { [ALICE]: "Alice" };
  assert.equal(
    describeReactors(group, (pubkey) => names[pubkey] ?? "Someone", ME),
    "You and Alice reacted with 👍",
  );
});

test("describeReactors omits You when the viewer did not react", () => {
  const index = upsertReaction(
    new Map(),
    { targetId: "t", emoji: "👍" },
    ALICE,
  );
  const [group] = reactionGroups(index, "t", ME);
  assert.equal(
    describeReactors(group, () => "Alice", ME),
    "Alice reacted with 👍",
  );
});

// ── removal ─────────────────────────────────────────────────────────────────

test("removeReaction drops only the named author from an emoji", () => {
  let index = new Map();
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ME);
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ALICE);
  const next = removeReaction(index, "t", "👍", ME);
  const [group] = reactionGroups(next, "t", ME);
  assert.deepEqual(group.pubkeys, [ALICE]);
  assert.equal(group.reactedByCurrentUser, false);
});

test("removeReaction deletes an emoji whose last reactor leaves", () => {
  let index = new Map();
  index = upsertReaction(index, { targetId: "t", emoji: "👍" }, ME);
  index = upsertReaction(index, { targetId: "t", emoji: "🔥" }, ALICE);
  const groups = reactionGroups(removeReaction(index, "t", "👍", ME), "t", ME);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].emoji, "🔥");
});

test("removeReaction drops the target entry once its last emoji goes", () => {
  const index = upsertReaction(new Map(), { targetId: "t", emoji: "👍" }, ME);
  const next = removeReaction(index, "t", "👍", ME);
  assert.equal(next.has("t"), false);
  assert.deepEqual(reactionGroups(next, "t", ME), []);
});

test("removeReaction returns the same index when nothing matched", () => {
  const index = upsertReaction(new Map(), { targetId: "t", emoji: "👍" }, ME);
  assert.equal(removeReaction(index, "t", "👍", ALICE), index);
  assert.equal(removeReaction(index, "t", "🔥", ME), index);
  assert.equal(removeReaction(index, "other", "👍", ME), index);
});

test("removeReaction does not mutate the index it was given", () => {
  const index = upsertReaction(new Map(), { targetId: "t", emoji: "👍" }, ME);
  removeReaction(index, "t", "👍", ME);
  assert.deepEqual(reactionGroups(index, "t", ME)[0].pubkeys, [ME]);
});

// ── the deletion event the relay demands ────────────────────────────────────

test("ownReactionFilter asks only for the viewer's kind-7 on that target", () => {
  assert.deepEqual(ownReactionFilter("target-id", ME), {
    kinds: [7],
    "#e": ["target-id"],
    authors: [ME],
  });
  assert.equal(REACTION_KIND, 7);
});

test("buildReactionDeleteTemplate is a kind-5 with exactly one e tag", () => {
  const template = buildReactionDeleteTemplate("reaction-id");
  assert.equal(template.kind, 5);
  assert.equal(REACTION_DELETE_KIND, 5);
  assert.equal(template.content, "");
  assert.deepEqual(template.tags, [["e", "reaction-id"]]);
  // The relay rejects a deletion with anything but one e-or-a target, and
  // derives the channel from the target — an h tag here would be wrong.
  assert.equal(template.tags.filter((tag) => tag[0] === "e").length, 1);
  assert.equal(
    template.tags.some((tag) => tag[0] === "h"),
    false,
  );
});

test("pickOwnReactionEventId ignores other authors, emoji and targets", () => {
  const wrongAuthor = {
    ...reactionEvent("👍", "t", ALICE),
    id: "wrong-author",
  };
  const wrongEmoji = { ...reactionEvent("🔥", "t", ME), id: "wrong-emoji" };
  const wrongTarget = {
    ...reactionEvent("👍", "other", ME),
    id: "wrong-target",
  };
  const wrongKind = {
    ...reactionEvent("👍", "t", ME),
    kind: 9,
    id: "wrong-kind",
  };
  const right = { ...reactionEvent("👍", "t", ME), id: "right" };
  assert.equal(
    pickOwnReactionEventId(
      [wrongAuthor, wrongEmoji, wrongTarget, wrongKind, right],
      { targetEventId: "t", emoji: "👍", selfPubkey: ME },
    ),
    "right",
  );
});

test("pickOwnReactionEventId returns null when the viewer has no reaction", () => {
  assert.equal(
    pickOwnReactionEventId([reactionEvent("👍", "t", ALICE)], {
      targetEventId: "t",
      emoji: "👍",
      selfPubkey: ME,
    }),
    null,
  );
});

test("pickOwnReactionEventId prefers the newest duplicate", () => {
  const older = {
    ...reactionEvent("👍", "t", ME),
    id: "older",
    created_at: 10,
  };
  const newer = {
    ...reactionEvent("👍", "t", ME),
    id: "newer",
    created_at: 20,
  };
  assert.equal(
    pickOwnReactionEventId([newer, older], {
      targetEventId: "t",
      emoji: "👍",
      selfPubkey: ME,
    }),
    "newer",
  );
  assert.equal(
    pickOwnReactionEventId([older, newer], {
      targetEventId: "t",
      emoji: "👍",
      selfPubkey: ME,
    }),
    "newer",
  );
});
