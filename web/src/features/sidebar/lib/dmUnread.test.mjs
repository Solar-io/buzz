import assert from "node:assert/strict";
import { test } from "node:test";
import { countsTowardDmUnread } from "./dmUnread.ts";

const SELF = "aa".repeat(32);
const PEER = "bb".repeat(32);
const AGENT = "cc".repeat(32);
/** buzz-services reminder identity — the wake sender. */
const WAKE_SERVICE =
  "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271";

const dmEvent = (overrides = {}) => ({
  kind: 9,
  pubkey: PEER,
  tags: [["h", "dm-1"]],
  ...overrides,
});

test("a peer's DM message counts toward the unread badge", () => {
  assert.equal(countsTowardDmUnread(dmEvent(), SELF), true);
});

test("the viewer's own DM message never counts", () => {
  assert.equal(countsTowardDmUnread(dmEvent({ pubkey: SELF }), SELF), false);
});

test("a wake for another DM member does not count toward the unread badge", () => {
  const wake = dmEvent({
    pubkey: WAKE_SERVICE,
    tags: [
      ["h", "dm-1"],
      ["p", AGENT],
    ],
  });
  assert.equal(countsTowardDmUnread(wake, SELF), false);
});

test("a wake that p-tags the viewer counts toward the unread badge", () => {
  const wake = dmEvent({
    pubkey: WAKE_SERVICE,
    tags: [
      ["h", "dm-1"],
      ["p", SELF],
    ],
  });
  assert.equal(countsTowardDmUnread(wake, SELF), true);
});
