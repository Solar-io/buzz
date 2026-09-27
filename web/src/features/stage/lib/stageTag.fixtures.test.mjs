import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildStageTag,
  parseStagePayload,
  parseStageTag,
  STAGE_LIMITS,
} from "./stageTag.ts";

/**
 * The TypeScript half of the shared Stage wire corpus. The Rust half is
 * `crates/buzz-cli/src/commands/stage_tag.rs`; both read THESE files, so a
 * bound or an error message changed on one side only turns exactly one suite
 * red. Schema: `test-fixtures/stage-mode/README.md`.
 */
function fixture(name) {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../../../test-fixtures/stage-mode/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

const limits = fixture("limits.json");
const cases = fixture("cases.json");

function rawOf(testCase) {
  return testCase.payloadRaw === undefined
    ? JSON.stringify(testCase.payload)
    : testCase.payloadRaw;
}

test("STAGE_LIMITS is the manifest, value for value", () => {
  const { cases: count, ...bounds } = limits;
  assert.deepEqual({ ...STAGE_LIMITS }, bounds);
  assert.equal(typeof count, "number");
});

test("the stage corpus is fully loaded — the count guards an empty harness", () => {
  assert.equal(cases.length, limits.cases);
  assert.ok(cases.length >= 30, `corpus is too small (${cases.length})`);
  for (const testCase of cases) {
    assert.equal(typeof testCase.name, "string");
    assert.ok(testCase.expect === "accept" || testCase.expect === "reject");
    assert.ok(
      (testCase.payload === undefined) !== (testCase.payloadRaw === undefined),
      `${testCase.name}: exactly one of payload / payloadRaw`,
    );
  }
});

test("every accept case parses and rebuilds to its exact canonical", () => {
  const accepted = cases.filter((entry) => entry.expect === "accept");
  assert.equal(accepted.length, 12, "accept-case count moved");
  for (const testCase of accepted) {
    const result = parseStagePayload(rawOf(testCase));
    assert.ok(result.ok, `${testCase.name}: ${result.reason}`);
    const [name, json] = buildStageTag(result.tag);
    assert.equal(name, "stage");
    assert.deepEqual(JSON.parse(json), testCase.canonical, testCase.name);
    // The canonical itself round-trips to the same parsed tag.
    const again = parseStageTag([
      ["stage", JSON.stringify(testCase.canonical)],
    ]);
    assert.deepEqual(again, result.tag, `${testCase.name}: round-trip`);
  }
});

test("every reject case is refused, with the shared reason", () => {
  const rejected = cases.filter((entry) => entry.expect === "reject");
  assert.equal(rejected.length, 30, "reject-case count moved");
  for (const testCase of rejected) {
    const result = parseStagePayload(rawOf(testCase));
    assert.equal(result.ok, false, `${testCase.name}: expected reject`);
    assert.ok(
      result.reason.includes(testCase.reason),
      `${testCase.name}: ${JSON.stringify(result.reason)} does not contain ${JSON.stringify(testCase.reason)}`,
    );
    assert.equal(
      parseStageTag([["stage", rawOf(testCase)]]),
      null,
      testCase.name,
    );
  }
});

test("hold is materialized: absent → true, false kept", () => {
  const s = "a".repeat(64);
  assert.equal(
    parseStageTag([["stage", `{"v":1,"op":"part","s":"${s}","i":0}`]]).hold,
    true,
  );
  assert.equal(
    parseStageTag([
      ["stage", `{"v":1,"op":"part","s":"${s}","i":0,"hold":false}`],
    ]).hold,
    false,
  );
});

test("parseStageTag ignores other tags and returns null with no stage tag", () => {
  assert.equal(
    parseStageTag([
      ["imeta", "url x"],
      ["h", "c"],
    ]),
    null,
  );
});
