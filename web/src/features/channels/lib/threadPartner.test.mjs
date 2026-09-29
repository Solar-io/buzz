import assert from "node:assert/strict";
import { test } from "node:test";

import { threadPartner } from "./threadPartner.ts";

const SAM = "5".repeat(64);
const X = "0".repeat(64);
const Y = "1".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const AGENTS = new Set([X, Y]);

const thread = (...authors) =>
  authors.map((author) =>
    typeof author === "string" ? { authorPubkey: author } : author,
  );
const partner = (...authors) => threadPartner(thread(...authors), SAM, AGENTS);

test("Sam's 2026-09-29 thread: an earlier second agent no longer blocks the default", () => {
  assert.equal(partner(X, Y, X, SAM, X, SAM), X);
});

test("his first reply in that thread already defaults to the newest agent", () => {
  assert.equal(partner(X, Y, X), X);
});

test("a one-off second agent after Sam joined doesn't switch it off for good", () => {
  assert.equal(partner(X, SAM, Y, SAM, X, SAM), X);
  assert.equal(partner(X, SAM, Y, SAM, X), X);
});

test("two different agents since Sam's last message: no default", () => {
  assert.equal(partner(X, SAM, X, Y), null);
  assert.equal(partner(SAM, Y, X), null);
});

test("the agent rule never picks a human", () => {
  assert.equal(partner(X, ALICE, SAM), X, "agent root, human comment");
  assert.equal(
    partner(ALICE, BOB, SAM),
    null,
    "human-only three-person thread",
  );
  assert.equal(partner(ALICE), null, "human root, Sam hasn't posted");
});

test("two-person threads still tag the other side, human or agent", () => {
  assert.equal(threadPartner(thread(ALICE, SAM), SAM), ALICE);
  assert.equal(threadPartner(thread(ALICE, SAM), ALICE), SAM);
  assert.equal(partner(SAM, X), X);
});

test("without the agent set only the two-person rule applies", () => {
  assert.equal(threadPartner(thread(X), SAM), null);
  assert.equal(threadPartner(thread(X, Y, X, SAM, X), SAM), null);
});

test("solo threads and deleted messages", () => {
  assert.equal(partner(SAM, SAM), null);
  assert.equal(partner({ authorPubkey: X, deleted: true }, SAM), null);
  assert.equal(
    partner(X, SAM, { authorPubkey: Y, deleted: true }, X),
    X,
    "a deleted second-agent reply doesn't block the default",
  );
});
