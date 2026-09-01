import assert from "node:assert/strict";
import { test } from "node:test";
import { recordTyping, activeTyping } from "./typing.ts";

const SELF = "aa".repeat(32);
const PEER = "bb".repeat(32);

test("activeTyping returns fresh peers in the channel, excluding self", () => {
  let map = recordTyping(new Map(), "ch1", PEER, Date.now());
  map = recordTyping(map, "ch1", SELF, Date.now());
  const active = activeTyping(map, "ch1", SELF, Date.now());
  assert.deepEqual(active, [PEER]);
});

test("entries older than the TTL expire", () => {
  const old = Date.now() - 10_000;
  const map = recordTyping(new Map(), "ch1", PEER, old);
  assert.equal(activeTyping(map, "ch1", SELF, Date.now()).length, 0);
});

test("entries in other channels do not leak", () => {
  const map = recordTyping(new Map(), "ch2", PEER, Date.now());
  assert.equal(activeTyping(map, "ch1", SELF, Date.now()).length, 0);
});
