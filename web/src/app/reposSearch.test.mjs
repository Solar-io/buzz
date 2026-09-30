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
    item: undefined,
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
    item: undefined,
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

test("?item= opens one item, only on the Items view and only as an item id", () => {
  assert.equal(
    validateReposSearch({ view: "items", item: "7f3k2m9qa1bc" }).item,
    "7f3k2m9qa1bc",
  );
  assert.equal(validateReposSearch({ view: "items" }).view, "items");
  // Elsewhere it means nothing, so it is not kept.
  assert.equal(
    validateReposSearch({ view: "work", item: "7f3k2m9qa1bc" }).item,
    undefined,
  );
  // Not a Crockford id: `u` is outside the alphabet; 11 and 13 chars.
  for (const bad of ["7f3k2m9qa1bu", "7f3k2m9qa1b", "7f3k2m9qa1bcd", 7]) {
    assert.equal(
      validateReposSearch({ view: "items", item: bad }).item,
      undefined,
    );
  }
});
