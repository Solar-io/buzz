import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeMentionQuery,
  extractMentionTokens,
  resolveMentions,
} from "./mentions.ts";

const SAM = "a".repeat(64);
const EVIE = "b".repeat(64);
const NIKON = "c".repeat(64);

const members = [
  { pubkey: SAM, name: "Sam" },
  { pubkey: EVIE, name: "Evie" },
  { pubkey: NIKON, name: "Lord Nikon" },
];

test("extracts plain tokens", () => {
  const tokens = extractMentionTokens("hi @Sam and @Evie!");
  assert.deepEqual(
    tokens.map((t) => t.name),
    ["Sam", "Evie"],
  );
});

test("ignores mentions inside fenced and inline code", () => {
  const tokens = extractMentionTokens(
    "x @Sam `code @Evie` y\n```\n@Lord Nikon\n```",
  );
  assert.deepEqual(
    tokens.map((t) => t.name),
    ["Sam"],
  );
});

test("stops at spaces (names with spaces need exact typing)", () => {
  const tokens = extractMentionTokens("@Lord");
  assert.deepEqual(
    tokens.map((t) => t.name),
    ["Lord"],
  );
});

test("resolveMentions maps unique names to pubkeys", () => {
  const { mentionPubkeys, unresolved } = resolveMentions(
    "hey @Sam — @Evie",
    members,
  );
  assert.deepEqual(mentionPubkeys, [SAM, EVIE]);
  assert.deepEqual(unresolved, []);
});

test("multi-word and unknown names stay unresolved", () => {
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@Lord Nikon @Nobody",
    members,
  );
  // "@Lord Nikon" tokenizes as just @Lord (the name stops at the space), so
  // neither half of "Lord Nikon" p-tags anyone from prose.
  assert.deepEqual(mentionPubkeys, []);
  assert.deepEqual(unresolved, ["Lord", "Nobody"]);
});

test("duplicate mentions dedupe to one p tag", () => {
  const { mentionPubkeys } = resolveMentions("@Sam @Sam @Sam", members);
  assert.deepEqual(mentionPubkeys, [SAM]);
});

test("activeMentionQuery finds the token at the caret", () => {
  assert.equal(activeMentionQuery("hello @Sa", 9), "Sa");
  assert.equal(activeMentionQuery("hello @Sam and @Ev", 18), "Ev");
  assert.equal(activeMentionQuery("hello  rest", 11), null);
  assert.equal(activeMentionQuery("email@example.com", 5), null);
});
