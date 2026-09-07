import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionParts } from "./mentionParts.ts";

// NOTE: a regression here is a SYNCHRONOUS infinite loop — the runner would
// hang, not report a failure. That is the failure mode of the bug this pins
// (2026-08-29: non-matching @token + continue never re-exec'd the regex).
test("non-matching tokens are skipped without hanging, later matches found", () => {
  const parts = mentionParts(
    "mail evie@noet.me then hey @Sam ok",
    new Set(["sam"]),
  );
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["text", "mail evie@noet.me then hey "],
      ["mention", "@Sam"],
      ["text", " ok"],
    ],
  );
  assert.ok(
    new Set(parts.map((x) => x.key)).size === parts.length,
    "keys unique",
  );
});

test("multiple and consecutive mentions", () => {
  const parts = mentionParts(
    "@Sam @Evie and @Sam again",
    new Set(["sam", "evie"]),
  );
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["mention", "@Sam"],
      ["text", " "],
      ["mention", "@Evie"],
      ["text", " and "],
      ["mention", "@Sam"],
      ["text", " again"],
    ],
  );
});

test("no matches or empty name set returns null (caller keeps the node)", () => {
  assert.equal(mentionParts("plain text", new Set(["sam"])), null);
  assert.equal(mentionParts("@Sam hi", new Set()), null);
  assert.equal(mentionParts("no tokens at all", new Set(["sam"])), null);
});

// --- multi-word display names ------------------------------------------------
// The renderer must use the SAME matching as the composer's resolver
// (longest known name, boundary-delimited) or a correctly-tagged
// "@Crash Override" pings but renders WITHOUT the mention highlight — the
// drift that shipped with the original tokenizer bug. Fixtures use real
// fleet display names.

test("a multi-word fleet name highlights as one mention", () => {
  const parts = mentionParts(
    "welcome @Crash Override aboard",
    new Set(["crash override"]),
  );
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["text", "welcome "],
      ["mention", "@Crash Override"],
      ["text", " aboard"],
    ],
  );
});

test("multi-word matching is case-insensitive, display case preserved", () => {
  const parts = mentionParts(
    "hey @CRASH OVERRIDE!",
    new Set(["Crash Override"]),
  );
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["text", "hey "],
      ["mention", "@CRASH OVERRIDE"],
      ["text", "!"],
    ],
  );
});

test("two multi-word mentions in one line both highlight", () => {
  const parts = mentionParts(
    "@Acid Burn meet @Cereal Killer",
    new Set(["acid burn", "cereal killer"]),
  );
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["mention", "@Acid Burn"],
      ["text", " meet "],
      ["mention", "@Cereal Killer"],
    ],
  );
});

test("the longest known name highlights, not its prefix", () => {
  const parts = mentionParts("@Sam Smith hi", new Set(["sam", "sam smith"]));
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["mention", "@Sam Smith"],
      ["text", " hi"],
    ],
  );
});

test("a run-on word does not highlight as the name", () => {
  // "OverrideX" is not "Override" ending on a boundary.
  assert.equal(
    mentionParts("@Crash OverrideX!", new Set(["crash override"])),
    null,
  );
});

test("prose after a multi-word mention stays plain text", () => {
  const parts = mentionParts(
    "@Lord Nikon and then some prose",
    new Set(["lord nikon"]),
  );
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["mention", "@Lord Nikon"],
      ["text", " and then some prose"],
    ],
  );
});

// --- @everyone ---------------------------------------------------------------

test("@everyone highlights when the event carries p tags", () => {
  // An @everyone send p-tags every member; any non-empty p-tag set plus the
  // reserved token in the body means the highlight.
  const parts = mentionParts("@everyone stand up", new Set(["sam"]));
  assert.deepEqual(
    parts.map((x) => [x.kind, x.text]),
    [
      ["mention", "@everyone"],
      ["text", " stand up"],
    ],
  );
});

test("@everyone stays plain when the event carries no p tags", () => {
  assert.equal(mentionParts("@everyone hi", new Set()), null);
});

test("@everyones does not highlight as @everyone", () => {
  assert.equal(mentionParts("@everyones!", new Set(["sam"])), null);
});
