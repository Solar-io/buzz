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
