import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildCardTag,
  cardFallbackText,
  parseCardTags,
  serializeCardPayload,
  CARD_LIMITS,
} from "./decisionCard.ts";

/**
 * The TypeScript half of the shared decision-card corpus. The Rust half is
 * `crates/buzz-cli/src/commands/card.rs`; both read THESE files, so a bound
 * or an error message changed on one side only turns exactly one suite red.
 * See `test-fixtures/decision-cards/README.md` for the case schema.
 */
function fixture(name) {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../../../test-fixtures/decision-cards/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

const limits = fixture("limits.json");
const cases = fixture("cases.json");

test("CARD_LIMITS is the manifest, value for value", () => {
  const { caseCount, ...bounds } = limits;
  assert.deepEqual({ ...CARD_LIMITS }, bounds);
  assert.equal(typeof caseCount, "number");
});

test("the corpus is fully loaded — the count guards an empty harness", () => {
  // A driver whose fixture resolved to nothing would run zero cases and
  // report success. The count is what makes that loud.
  assert.equal(cases.length, limits.caseCount);
  assert.ok(cases.length >= 18, `corpus is too small (${cases.length})`);
  for (const testCase of cases) {
    assert.equal(typeof testCase.name, "string");
    assert.ok(testCase.expect === "accept" || testCase.expect === "reject");
  }
});

test("every accept case builds its exact canonical payload and fallback", () => {
  const accepted = cases.filter((entry) => entry.expect === "accept");
  assert.ok(accepted.length > 0, "corpus has no accept cases");
  for (const testCase of accepted) {
    const { tag, fallbackContent } = buildCardTag(testCase.payload);
    assert.equal(tag.length, 1, testCase.name);
    assert.equal(tag[0][0], "card", testCase.name);
    assert.deepEqual(JSON.parse(tag[0][1]), testCase.canonical, testCase.name);
    assert.equal(fallbackContent, testCase.fallback, testCase.name);
    assert.ok(
      tag[0][1].length <= CARD_LIMITS.maxTagBytes,
      `${testCase.name}: canonical must fit the tag cap`,
    );
  }
});

test("every accept case's canonical parses and round-trips", () => {
  const accepted = cases.filter((entry) => entry.expect === "accept");
  assert.equal(accepted.length, 10, "accept-case count moved");
  for (const testCase of accepted) {
    const wire = JSON.stringify(testCase.canonical);
    const card = parseCardTags([["card", wire]]);
    assert.ok(card, `${testCase.name}: canonical must parse`);
    assert.equal(card.v, testCase.canonical.v, testCase.name);
    // serializeCardPayload is the inverse of parseCardTags — re-parsing what
    // it writes must yield the identical card, which is what lets the asks
    // cache store a payload rather than the parsed shape.
    const reparsed = parseCardTags([["card", serializeCardPayload(card)]]);
    assert.deepEqual(reparsed, card, `${testCase.name}: round-trip`);
    assert.equal(cardFallbackText(card), testCase.fallback, testCase.name);
  }
});

test("every reject case is refused by the builder, with the shared reason", () => {
  const rejected = cases.filter((entry) => entry.expect === "reject");
  assert.equal(rejected.length, 18, "reject-case count moved");
  for (const testCase of rejected) {
    assert.throws(
      () => buildCardTag(testCase.payload),
      (error) => {
        assert.ok(
          error.message.includes(testCase.reason),
          `${testCase.name}: ${JSON.stringify(error.message)} does not contain ${JSON.stringify(testCase.reason)}`,
        );
        return true;
      },
      testCase.name,
    );
  }
});

test("parseRaw pins every place the parser and the builder disagree", () => {
  const withExpectation = cases.filter((entry) => entry.parseRaw !== undefined);
  assert.equal(withExpectation.length, 5, "parseRaw case count moved");
  for (const testCase of withExpectation) {
    const parsed = parseCardTags([["card", JSON.stringify(testCase.payload)]]);
    if (testCase.parseRaw === "accept") {
      assert.ok(parsed, `${testCase.name}: raw payload must parse`);
    } else {
      assert.equal(
        parsed,
        null,
        `${testCase.name}: raw payload must not parse`,
      );
    }
  }
});

test("reject cases without a parseRaw expectation also fail the parse", () => {
  // The default for a refused payload is that the renderer refuses it too —
  // stated as an assertion so a new reject case that the parser happily
  // accepts has to say so out loud.
  let checked = 0;
  for (const testCase of cases) {
    if (testCase.expect !== "reject" || testCase.parseRaw !== undefined) {
      continue;
    }
    assert.equal(
      parseCardTags([["card", JSON.stringify(testCase.payload)]]),
      null,
      testCase.name,
    );
    checked += 1;
  }
  assert.equal(checked, 15, "default-reject case count moved");
});
