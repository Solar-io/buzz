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

// --- picked mentions ---------------------------------------------------------
// Resolving by display name cannot distinguish two members who share a name.
// A pick carries the pubkey the author actually clicked, so it can.

const AMBIGUOUS = [
  { pubkey: "a".repeat(64), name: "Sam" },
  { pubkey: "b".repeat(64), name: "Sam" },
];

test("an ambiguous name resolves to nothing without a pick", () => {
  const { mentionPubkeys, unresolved } = resolveMentions("hi @Sam", AMBIGUOUS);
  assert.deepEqual(mentionPubkeys, []);
  assert.deepEqual(unresolved, ["Sam"]);
});

test("a picked mention resolves an otherwise ambiguous name", () => {
  // The discriminating case: same text, same members, different outcome —
  // and it names WHICH of the two Sams, so a pick that returned either one
  // would fail half the time.
  const picks = new Map([["sam", "b".repeat(64)]]);
  const { mentionPubkeys, unresolved } = resolveMentions(
    "hi @Sam",
    AMBIGUOUS,
    picks,
  );
  assert.deepEqual(mentionPubkeys, ["b".repeat(64)]);
  assert.deepEqual(unresolved, []);
});

test("a pick beats a unique name match", () => {
  // Two different members; the pick must win over the name lookup, or an
  // author who picked one person would silently tag another.
  const members = [
    { pubkey: "c".repeat(64), name: "Sam" },
    { pubkey: "d".repeat(64), name: "Alex" },
  ];
  const picks = new Map([["sam", "d".repeat(64)]]);
  const { mentionPubkeys } = resolveMentions("hi @Sam", members, picks);
  assert.deepEqual(mentionPubkeys, ["d".repeat(64)]);
});

test("picks are matched case-insensitively against the typed token", () => {
  const picks = new Map([["sam", "a".repeat(64)]]);
  const { mentionPubkeys } = resolveMentions("hi @SAM", AMBIGUOUS, picks);
  assert.deepEqual(mentionPubkeys, ["a".repeat(64)]);
});

test("a pick for a name no longer in the text contributes nothing", () => {
  // Stale picks must not leak p-tags for people the message never mentions.
  const picks = new Map([["sam", "a".repeat(64)]]);
  const { mentionPubkeys } = resolveMentions(
    "no mentions here",
    AMBIGUOUS,
    picks,
  );
  assert.deepEqual(mentionPubkeys, []);
});

test("picked and typed mentions coexist in one message", () => {
  const members = [
    { pubkey: "a".repeat(64), name: "Sam" },
    { pubkey: "b".repeat(64), name: "Sam" },
    { pubkey: "e".repeat(64), name: "Alex" },
  ];
  const picks = new Map([["sam", "b".repeat(64)]]);
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@Sam and @Alex",
    members,
    picks,
  );
  assert.deepEqual(mentionPubkeys, ["b".repeat(64), "e".repeat(64)]);
  assert.deepEqual(unresolved, []);
});

test("a picked mention inside a code span is still ignored", () => {
  // Code-region masking must run before picks are consulted, or a pasted
  // snippet mentioning @Sam would tag them.
  const picks = new Map([["sam", "a".repeat(64)]]);
  const { mentionPubkeys } = resolveMentions("`@Sam`", AMBIGUOUS, picks);
  assert.deepEqual(mentionPubkeys, []);
});
