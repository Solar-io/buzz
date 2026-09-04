import assert from "node:assert/strict";
import { test } from "node:test";

import { filterNotes } from "./searchNotes.ts";
import { isProjectComment, withoutProjectComments } from "./projectComments.ts";
import { getReplyParent, noteSnippet } from "./replies.ts";

const ALICE = "aa".repeat(32);
const BOB = "bb".repeat(32);

function note(id, content, pubkey = ALICE, tags = []) {
  return { id, pubkey, createdAt: 1, content, tags };
}

const NOTES = [
  note("n1", "The relay ships on Friday"),
  note("n2", "lunch?", BOB),
  note("n3", "Friday retro notes", BOB),
];
const NAMES = new Map([
  [ALICE, "Alice Doe"],
  [BOB, "Bob Stone"],
]);

test("an empty query returns everything", () => {
  assert.equal(filterNotes(NOTES, "").length, 3);
  assert.equal(filterNotes(NOTES, "   ").length, 3);
});

test("a term matches note text, case-insensitively", () => {
  assert.deepEqual(
    filterNotes(NOTES, "friday").map((n) => n.id),
    ["n1", "n3"],
  );
});

test("a term matches the author's display name", () => {
  assert.deepEqual(
    filterNotes(NOTES, "bob", NAMES).map((n) => n.id),
    ["n2", "n3"],
  );
});

test("a term matches the author's pubkey", () => {
  assert.deepEqual(
    filterNotes(NOTES, ALICE, NAMES).map((n) => n.id),
    ["n1"],
  );
});

test("multiple terms narrow rather than widen", () => {
  // AND, not OR: adding a word must never bring back more rows.
  assert.deepEqual(
    filterNotes(NOTES, "bob friday", NAMES).map((n) => n.id),
    ["n3"],
  );
  assert.deepEqual(filterNotes(NOTES, "bob relay", NAMES), []);
});

test("filterNotes does not mutate its input", () => {
  const input = [...NOTES];
  filterNotes(input, "friday");
  assert.equal(input.length, 3);
});

test("a project comment is one tagged with a repo address", () => {
  const comment = note("c1", "LGTM", ALICE, [["a", `30617:${ALICE}:my-repo`]]);
  assert.equal(isProjectComment(comment), true);
});

test("a plain note, or one with an unrelated a tag, is not a project comment", () => {
  assert.equal(isProjectComment(note("n1", "hello")), false);
  assert.equal(
    isProjectComment(
      note("n2", "hello", ALICE, [["a", `30023:${ALICE}:post`]]),
    ),
    false,
  );
  assert.equal(
    isProjectComment(note("n3", "hello", ALICE, [["e", "something"]])),
    false,
  );
});

test("withoutProjectComments keeps everything else", () => {
  const feed = [
    note("keep", "hello"),
    note("drop", "LGTM", ALICE, [["a", `30617:${ALICE}:repo`]]),
  ];
  assert.deepEqual(
    withoutProjectComments(feed).map((n) => n.id),
    ["keep"],
  );
});

test("getReplyParent prefers an explicit reply marker", () => {
  const reply = note("r", "text", ALICE, [
    ["e", "root-id", "", "root"],
    ["e", "parent-id", "", "reply"],
  ]);
  assert.equal(getReplyParent(reply), "parent-id");
});

test("getReplyParent falls back to the last unmarked e tag", () => {
  const reply = note("r", "text", ALICE, [
    ["e", "root-id"],
    ["e", "parent-id"],
  ]);
  assert.equal(getReplyParent(reply), "parent-id");
});

test("getReplyParent uses root when it is the only reference", () => {
  const reply = note("r", "text", ALICE, [["e", "root-id", "", "root"]]);
  assert.equal(getReplyParent(reply), "root-id");
});

test("getReplyParent returns null for a top-level note", () => {
  assert.equal(getReplyParent(note("n", "text")), null);
  assert.equal(getReplyParent(note("n", "text", ALICE, [["p", BOB]])), null);
});

test("noteSnippet collapses whitespace and truncates", () => {
  assert.equal(noteSnippet("  hello\n\n  world  "), "hello world");
  assert.equal(noteSnippet("x".repeat(500)).length, 120);
  assert.equal(noteSnippet("x".repeat(500), 10).length, 10);
});
