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
  // A span gloms single-space-separated words after the @, so "Sam and" is
  // ONE token. Resolution never treats the span itself as a name — it takes
  // the longest KNOWN name inside it — so prose words riding along are inert
  // (pinned by the resolve test below).
  const tokens = extractMentionTokens("hi @Sam and @Evie!");
  assert.deepEqual(
    tokens.map((t) => t.name),
    ["Sam and", "Evie"],
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

test("a span crosses single spaces but stops at doubles", () => {
  // Single spaces are part of a typed mention (multi-word display names);
  // a double space is prose, so the span ends before it.
  assert.deepEqual(
    extractMentionTokens("@Lord Nikon").map((t) => t.name),
    ["Lord Nikon"],
  );
  assert.deepEqual(
    extractMentionTokens("@Lord  Nikon").map((t) => t.name),
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

test("multi-word names resolve; unknown names stay unresolved", () => {
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@Lord Nikon @Nobody",
    members,
  );
  assert.deepEqual(mentionPubkeys, [NIKON]);
  assert.deepEqual(unresolved, ["Nobody"]);
});

// --- multi-word display names ------------------------------------------------
// Live regression (2026-09-06): the old tokenizer stopped at the first space,
// so EVERY multi-word display name in the fleet failed to tag. Fixtures use
// real fleet display names because they are the shapes that shipped broken.

const CRASH = "d".repeat(64);
const BURN = "e".repeat(64);
const KILLER = "f".repeat(64);

const fleet = [
  { pubkey: SAM, name: "Sam" },
  { pubkey: EVIE, name: "Evie" },
  { pubkey: CRASH, name: "Crash Override" },
  { pubkey: BURN, name: "Acid Burn" },
  { pubkey: NIKON, name: "Lord Nikon" },
  { pubkey: KILLER, name: "Cereal Killer" },
];

test("multi-word fleet names resolve from plain prose", () => {
  const { mentionPubkeys, unresolved } = resolveMentions(
    "welcome @Crash Override and @Acid Burn",
    fleet,
  );
  assert.deepEqual(mentionPubkeys, [CRASH, BURN]);
  assert.deepEqual(unresolved, []);
});

test("prose words glommed onto a span tag nobody", () => {
  // "hi @Sam and @Evie!" tokenizes as spans "Sam and" + "Evie"; the prose
  // word "and" must not turn the span into an unknown name that blocks the
  // real mentions.
  const { mentionPubkeys, unresolved } = resolveMentions(
    "hi @Sam and @Evie!",
    fleet,
  );
  assert.deepEqual(mentionPubkeys, [SAM, EVIE]);
  assert.deepEqual(unresolved, []);
});

test("a picked multi-word mention resolves the clicked member", () => {
  // Two members share the display name; the pick names WHICH one, and it is
  // not the first — so a resolution that ignored picks or picked the wrong
  // entry fails.
  const stuntz = "1".repeat(64);
  const ambiguousFleet = [
    { pubkey: CRASH, name: "Crash Override" },
    { pubkey: stuntz, name: "Crash Override" },
  ];
  const picks = new Map([["crash override", stuntz]]);
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@Crash Override you in?",
    ambiguousFleet,
    picks,
  );
  assert.deepEqual(mentionPubkeys, [stuntz]);
  assert.deepEqual(unresolved, []);
});

test("an unpicked ambiguous multi-word name stays unresolved", () => {
  const stuntz = "1".repeat(64);
  const ambiguousFleet = [
    { pubkey: CRASH, name: "Crash Override" },
    { pubkey: stuntz, name: "Crash Override" },
  ];
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@Crash Override you in?",
    ambiguousFleet,
  );
  assert.deepEqual(mentionPubkeys, []);
  assert.deepEqual(unresolved, ["Crash Override"]);
});

test("the longest known name wins at each @", () => {
  const smith = "2".repeat(64);
  const roster = [
    { pubkey: SAM, name: "Sam" },
    { pubkey: smith, name: "Sam Smith" },
  ];
  const { mentionPubkeys } = resolveMentions("@Sam Smith around?", roster);
  assert.deepEqual(mentionPubkeys, [smith]);
});

test("a candidate must end on a boundary, not inside a longer word", () => {
  const smith = "2".repeat(64);
  const roster = [
    { pubkey: SAM, name: "Sam" },
    { pubkey: smith, name: "Sam Smith" },
  ];
  // "Sam Smithson" is NOT "Sam Smith" run together — the boundary check
  // rejects the longer candidate and the shorter real name still tags.
  const shorter = resolveMentions("@Sam Smithson hi", roster);
  assert.deepEqual(shorter.mentionPubkeys, [SAM]);
  const runOn = resolveMentions("@Crash OverrideX!", fleet);
  assert.deepEqual(runOn.mentionPubkeys, []);
  assert.deepEqual(runOn.unresolved, ["Crash OverrideX"]);
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

test("activeMentionQuery spans spaces mid-name", () => {
  // The popup has to survive typing the space inside "Lord Nikon", or every
  // multi-word name dies at its first keystroke after the space.
  assert.equal(activeMentionQuery("hey @Lord Ni", 12), "Lord Ni");
  assert.equal(activeMentionQuery("hey @Crash O", 12), "Crash O");
  assert.equal(activeMentionQuery("@Cereal Ki", 10), "Cereal Ki");
  // A trailing space ends the query: the popup blinks for one keystroke
  // between words rather than living through ordinary prose.
  assert.equal(activeMentionQuery("@Crash ", 7), null);
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

// --- @everyone ---------------------------------------------------------------
// Sam 2026-09-06: "it would be very nice if we could have an @everyone which
// pinged everyone. Even if that just expanded out to everyone's name in the
// channel." The token expands at resolve time to every member's pubkey minus
// the author's own.

test("@everyone expands to every member except the author", () => {
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@everyone stand up",
    fleet,
    undefined,
    SAM,
  );
  assert.deepEqual(mentionPubkeys, [EVIE, CRASH, BURN, NIKON, KILLER]);
  assert.deepEqual(unresolved, []);
});

test("@everyone without a self key still includes all members", () => {
  // Degenerate caller (no session identity yet): expansion is still correct,
  // just unfiltered.
  const { mentionPubkeys } = resolveMentions("@everyone", fleet);
  assert.deepEqual(mentionPubkeys, [SAM, EVIE, CRASH, BURN, NIKON, KILLER]);
});

test("@everyone in a 1:1 DM expands to the other member", () => {
  const { mentionPubkeys } = resolveMentions(
    "@everyone read this",
    [members[0], members[1]],
    undefined,
    SAM,
  );
  assert.deepEqual(mentionPubkeys, [EVIE]);
});

test("@everyone dedupes repeated member entries", () => {
  const withDupe = [...fleet, { pubkey: CRASH, name: "Crash Override" }];
  const { mentionPubkeys } = resolveMentions("@everyone", withDupe);
  assert.deepEqual(mentionPubkeys, [SAM, EVIE, CRASH, BURN, NIKON, KILLER]);
});

test("@everyone coexists with a named mention in one message", () => {
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@everyone ping @Cereal Killer too",
    fleet,
    undefined,
    SAM,
  );
  assert.deepEqual(mentionPubkeys, [EVIE, CRASH, BURN, NIKON, KILLER]);
  assert.deepEqual(unresolved, []);
});

test("@everyone expands before punctuation", () => {
  const { mentionPubkeys } = resolveMentions(
    "@everyone!",
    fleet,
    undefined,
    SAM,
  );
  assert.deepEqual(mentionPubkeys, [EVIE, CRASH, BURN, NIKON, KILLER]);
});

test("@everyone is reserved even when a member is named Everyone", () => {
  const everyoneMember = "3".repeat(64);
  const roster = [
    { pubkey: SAM, name: "Sam" },
    { pubkey: everyoneMember, name: "Everyone" },
    { pubkey: EVIE, name: "Evie" },
  ];
  const { mentionPubkeys } = resolveMentions(
    "@everyone hi",
    roster,
    undefined,
    SAM,
  );
  // Expansion (Everyone + Evie), not the single member named Everyone.
  assert.deepEqual(mentionPubkeys, [everyoneMember, EVIE]);
});

test("@everyones is not @everyone", () => {
  // Boundary-delimited: the run-on word neither expands nor tags a member
  // whose name is a prefix of it.
  const everyoneMember = "3".repeat(64);
  const roster = [
    { pubkey: SAM, name: "Sam" },
    { pubkey: everyoneMember, name: "Everyone" },
  ];
  const { mentionPubkeys, unresolved } = resolveMentions(
    "@everyones!",
    roster,
    undefined,
    SAM,
  );
  assert.deepEqual(mentionPubkeys, []);
  assert.deepEqual(unresolved, ["everyones"]);
});
