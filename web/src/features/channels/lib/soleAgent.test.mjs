import assert from "node:assert/strict";
import { test } from "node:test";

import { soleAgent } from "./soleAgent.ts";

const SAM = "5".repeat(64);
const X = "0".repeat(64);
const Y = "1".repeat(64);
const ALICE = "a".repeat(64);
const AGENTS = new Set([X, Y]);

test("Sam's Tallyx channel: Sam + one agent tags that agent", () => {
  assert.equal(soleAgent([SAM, X], SAM, AGENTS), X);
});

test("a 1:1 DM roster (sender already excluded) tags the agent", () => {
  assert.equal(soleAgent([X], SAM, AGENTS), X);
});

test("other humans in the room don't block the default", () => {
  assert.equal(soleAgent([SAM, ALICE, X], SAM, AGENTS), X);
});

test("two agents in the room: no guess", () => {
  assert.equal(soleAgent([SAM, X, Y], SAM, AGENTS), null);
});

test("no agent in the room: nobody", () => {
  assert.equal(soleAgent([SAM, ALICE], SAM, AGENTS), null);
  assert.equal(soleAgent([], SAM, AGENTS), null);
});

test("an agent sender never tags itself", () => {
  assert.equal(soleAgent([X, Y], X, AGENTS), Y);
  assert.equal(soleAgent([X], X, AGENTS), null);
});

test("uppercase member keys match the lowercase agent set and keep their form", () => {
  const upper = "C".repeat(64);
  assert.equal(soleAgent([SAM, upper], SAM, new Set(["c".repeat(64)])), upper);
});

test("a duplicate roster entry is still one agent", () => {
  assert.equal(soleAgent([SAM, X, X], SAM, AGENTS), X);
});
