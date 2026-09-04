import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isHexPubkey,
  normalizeFromHandle,
  normalizeInChannel,
  parseSearchOperators,
  resolveAuthorOperator,
  resolveChannelOperator,
} from "./parseSearchOperators.ts";

const HEX = "a".repeat(64);

function localMidnight(year, month, day) {
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000);
}

test("plain text passes through untouched", () => {
  const parsed = parseSearchOperators("  deploy   rollback  ");
  assert.equal(parsed.text, "deploy rollback");
  assert.equal(parsed.from, null);
  assert.equal(parsed.in, null);
  assert.equal(parsed.since, null);
  assert.equal(parsed.until, null);
});

test("from: and in: are lifted out of the text", () => {
  const parsed = parseSearchOperators("from:@ada in:#general deploy");
  assert.equal(parsed.from, "@ada");
  assert.equal(parsed.in, "#general");
  assert.equal(parsed.text, "deploy");
});

test("after: and before: become inclusive since / exclusive until", () => {
  const parsed = parseSearchOperators("after:2025-03-01 before:2025-03-05 x");
  assert.equal(parsed.since, localMidnight(2025, 3, 1));
  // NIP-01 `until` is inclusive, so `before:` steps back one second — the
  // named day's own midnight must NOT match.
  assert.equal(parsed.until, localMidnight(2025, 3, 5) - 1);
  assert.equal(parsed.text, "x");
});

test("an operator must start at a token boundary, not a word boundary", () => {
  // \b fires after "-" and "/", which would eat both of these.
  const hyphen = parseSearchOperators("built-in:react");
  assert.equal(hyphen.in, null);
  assert.equal(hyphen.text, "built-in:react");

  const url = parseSearchOperators("https://x.com/in:foo");
  assert.equal(url.in, null);
  assert.equal(url.text, "https://x.com/in:foo");
});

test("an unparseable date stays in the text instead of being dropped", () => {
  const parsed = parseSearchOperators("after:yesterday outage");
  assert.equal(parsed.since, null);
  assert.equal(parsed.text, "after:yesterday outage");
});

test("an impossible calendar date is not silently rolled forward", () => {
  // new Date(2025, 1, 30) is 2 March. Accepting it would search a range the
  // user never asked for.
  const parsed = parseSearchOperators("after:2025-02-30 x");
  assert.equal(parsed.since, null);
  assert.equal(parsed.text, "after:2025-02-30 x");
});

test("trailing punctuation is stripped from an operator value", () => {
  assert.equal(parseSearchOperators("in:general, deploy").in, "general");
});

test("the last occurrence of an operator wins", () => {
  const parsed = parseSearchOperators("in:a in:b text");
  assert.equal(parsed.in, "b");
  assert.equal(parsed.text, "text");
});

test("operators are case-insensitive", () => {
  assert.equal(parseSearchOperators("FROM:ada x").from, "ada");
  assert.equal(parseSearchOperators("In:general x").in, "general");
});

test("isHexPubkey accepts only a full 32-byte key", () => {
  assert.equal(isHexPubkey(HEX), true);
  assert.equal(isHexPubkey(HEX.toUpperCase()), true);
  assert.equal(isHexPubkey(HEX.slice(1)), false);
  assert.equal(isHexPubkey(`${HEX}a`), false);
  assert.equal(isHexPubkey(`${HEX.slice(1)}z`), false);
});

test("handle and channel prefixes are stripped", () => {
  assert.equal(normalizeFromHandle("@ada"), "ada");
  assert.equal(normalizeFromHandle("ada"), "ada");
  assert.equal(normalizeInChannel("#general"), "general");
  assert.equal(normalizeInChannel("general"), "general");
});

const CHANNELS = [
  { id: "c-1", name: "general" },
  { id: "c-2", name: "Deploys" },
];

test("in: resolves by exact id and by case-insensitive name", () => {
  assert.deepEqual(resolveChannelOperator("c-2", CHANNELS), {
    status: "resolved",
    value: "c-2",
  });
  assert.deepEqual(resolveChannelOperator("#deploys", CHANNELS), {
    status: "resolved",
    value: "c-2",
  });
});

test("an operator that matches nothing is UNRESOLVED, not absent", () => {
  // The distinction is what stops `in:nowhere` from silently searching
  // everywhere.
  assert.deepEqual(resolveChannelOperator("#nope", CHANNELS), {
    status: "unresolved",
  });
  assert.deepEqual(resolveChannelOperator(null, CHANNELS), { status: "none" });
  assert.deepEqual(resolveChannelOperator("#", CHANNELS), { status: "none" });
});

const PEOPLE = [
  { pubkey: HEX, displayName: "Ada Lovelace" },
  { pubkey: "b".repeat(64), displayName: null },
];

test("from: resolves hex directly and a handle by display name", () => {
  assert.deepEqual(resolveAuthorOperator(HEX.toUpperCase(), []), {
    status: "resolved",
    value: HEX,
  });
  // The resolver itself handles a multi-word name…
  assert.deepEqual(resolveAuthorOperator("@Ada Lovelace", PEOPLE), {
    status: "resolved",
    value: HEX,
  });
  assert.deepEqual(resolveAuthorOperator("@AdaLovelace", PEOPLE), {
    status: "unresolved",
  });
});

test("…but the PARSER only captures the first token of a handle", () => {
  // A known limitation, inherited from the desktop's operator syntax: the
  // operator regex is `\S+`, so `from:@Ada Lovelace` sends "Lovelace" to the
  // full-text search and leaves `from:` holding only "@Ada". Pinned here so
  // the day someone quotes handles, this test says what changed.
  const parsed = parseSearchOperators("from:@Ada Lovelace deploy");
  assert.equal(parsed.from, "@Ada");
  assert.equal(parsed.text, "Lovelace deploy");
  assert.deepEqual(resolveAuthorOperator(parsed.from, PEOPLE), {
    status: "unresolved",
  });
});

test("from: matches a single-token display name exactly", () => {
  const people = [{ pubkey: HEX, displayName: "Ada" }];
  assert.deepEqual(resolveAuthorOperator("@ada", people), {
    status: "resolved",
    value: HEX,
  });
  assert.deepEqual(resolveAuthorOperator("@ADA", people), {
    status: "resolved",
    value: HEX,
  });
});

test("an unknown from: handle is unresolved rather than everyone", () => {
  assert.deepEqual(resolveAuthorOperator("@nobody", PEOPLE), {
    status: "unresolved",
  });
  assert.deepEqual(resolveAuthorOperator(null, PEOPLE), { status: "none" });
});
