import assert from "node:assert/strict";
import { test } from "node:test";

import { validateReposSearch } from "./reposSearch.ts";

const ID = "ab".repeat(32);

test("?stage= keeps a 64-hex open id alongside c", () => {
  assert.deepEqual(validateReposSearch({ c: "chan", stage: ID }), {
    c: "chan",
    m: undefined,
    view: undefined,
    stage: ID,
    reply: undefined,
  });
});

test("?stage= drops anything that is not an event id", () => {
  for (const bad of ["nope", ID.toUpperCase(), `${ID}0`, 5, null]) {
    assert.equal(validateReposSearch({ stage: bad }).stage, undefined);
  }
});

test("existing params are unchanged (view whitelist, m, c)", () => {
  assert.deepEqual(validateReposSearch({ c: "x", m: "y", view: "inbox" }), {
    c: "x",
    m: "y",
    view: "inbox",
    stage: undefined,
    reply: undefined,
  });
  assert.equal(validateReposSearch({ view: "bogus" }).view, undefined);
});

test("?reply= only counts alongside the message it replies to", () => {
  assert.equal(validateReposSearch({ c: "x", m: "y", reply: "1" }).reply, true);
  assert.equal(validateReposSearch({ c: "x", m: "y", reply: 1 }).reply, true);
  // No message, nothing to reply to: a stray flag must not focus anything.
  assert.equal(validateReposSearch({ c: "x", reply: "1" }).reply, undefined);
  assert.equal(
    validateReposSearch({ c: "x", m: "y", reply: "yes" }).reply,
    undefined,
  );
});
