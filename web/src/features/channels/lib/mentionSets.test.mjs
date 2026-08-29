import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionSetsEqual } from "./mentionSets.ts";

test("equal contents in fresh Set instances compare equal (memo must hold)", () => {
  const a = new Set(["sam", "evie"]);
  const b = new Set(["evie", "sam"]);
  assert.equal(mentionSetsEqual(a, b), true);
});

test("different contents or sizes compare unequal", () => {
  assert.equal(
    mentionSetsEqual(new Set(["sam"]), new Set(["sam", "evie"])),
    false,
  );
  assert.equal(mentionSetsEqual(new Set(["sam"]), new Set(["nikon"])), false);
});

test("same reference and empty sets compare equal", () => {
  const a = new Set();
  assert.equal(mentionSetsEqual(a, a), true);
  assert.equal(mentionSetsEqual(new Set(), new Set()), true);
});
