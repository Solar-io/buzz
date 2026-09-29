import assert from "node:assert/strict";
import { test } from "node:test";

import { threadPartner } from "./threadPartner.ts";

const SAM = "5".repeat(64);
const OPUS = "0".repeat(64);
const OPUS1 = "1".repeat(64);
const ALICE = "a".repeat(64);
const AGENTS = new Set([OPUS, OPUS1]);

const thread = (...authors) =>
  authors.map((authorPubkey) =>
    typeof authorPubkey === "string" ? { authorPubkey } : authorPubkey,
  );

test("Sam's 2026-09-29 thread: an earlier second agent no longer blocks the partner", () => {
  // Opus root, Opus 1 answers once, Opus follows up; then Sam and Opus talk.
  const messages = thread(OPUS, OPUS1, OPUS, SAM, OPUS, SAM);
  assert.equal(threadPartner(messages, SAM, AGENTS), OPUS);
});

test("the responder wins over whoever the viewer first answered", () => {
  assert.equal(
    threadPartner(thread(OPUS, OPUS1, SAM, OPUS), SAM, AGENTS),
    OPUS,
  );
  assert.equal(threadPartner(thread(OPUS, OPUS1, SAM), SAM, AGENTS), OPUS1);
});

test("two-person threads still tag the other side, both directions", () => {
  assert.equal(threadPartner(thread(ALICE, SAM), SAM), ALICE);
  assert.equal(threadPartner(thread(ALICE, SAM), ALICE), SAM);
});

test("a second voice after the viewer joined means no default", () => {
  assert.equal(
    threadPartner(thread(OPUS, SAM, OPUS, OPUS1), SAM, AGENTS),
    null,
  );
  assert.equal(threadPartner(thread(SAM, OPUS, OPUS1), SAM, AGENTS), null);
});

test("viewer never posted: a single agent author is the partner, a human is not", () => {
  assert.equal(threadPartner(thread(OPUS, OPUS), SAM, AGENTS), OPUS);
  assert.equal(threadPartner(thread(ALICE), SAM, AGENTS), null);
  assert.equal(
    threadPartner(thread(OPUS), SAM),
    null,
    "no agent set, no guess",
  );
  assert.equal(threadPartner(thread(OPUS, OPUS1), SAM, AGENTS), null);
});

test("solo threads and deleted-only partners tag nobody", () => {
  assert.equal(threadPartner(thread(SAM, SAM), SAM, AGENTS), null);
  const gone = thread({ authorPubkey: OPUS, deleted: true }, SAM);
  assert.equal(threadPartner(gone, SAM, AGENTS), null);
  const stillHere = thread(
    OPUS,
    SAM,
    { authorPubkey: OPUS1, deleted: true },
    OPUS,
  );
  assert.equal(threadPartner(stillHere, SAM, AGENTS), OPUS);
});
