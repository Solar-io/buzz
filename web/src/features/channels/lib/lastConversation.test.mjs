import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAST_CONVERSATION_PREFIX,
  clearLastConversation,
  landingRedirectTarget,
  loadLastConversation,
  restoreVerdict,
  saveLastConversation,
} from "./lastConversation.ts";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

test("save → load round-trips per relay scope", () => {
  const storage = memoryStorage();
  saveLastConversation(storage, "wss://a", {
    channelId: "dm-y",
    at: 5,
    pubkey: "me",
  });
  assert.deepEqual(loadLastConversation(storage, "wss://a"), {
    channelId: "dm-y",
    at: 5,
    pubkey: "me",
  });
  assert.equal(loadLastConversation(storage, "wss://b"), null);
  assert.ok(storage.map.has(`${LAST_CONVERSATION_PREFIX}wss://a`));
});

test("garbage, empty ids and throwing storage load as nothing", () => {
  const scope = "wss://a";
  const key = LAST_CONVERSATION_PREFIX + scope;
  assert.equal(
    loadLastConversation(memoryStorage({ [key]: "{" }), scope),
    null,
  );
  assert.equal(
    loadLastConversation(
      memoryStorage({ [key]: JSON.stringify({ channelId: "" }) }),
      scope,
    ),
    null,
  );
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
  };
  assert.equal(loadLastConversation(throwing, scope), null);
  assert.equal(loadLastConversation(null, scope), null);
});

test("clear removes the entry", () => {
  const storage = memoryStorage();
  saveLastConversation(storage, "s", { channelId: "c", at: 1, pubkey: null });
  clearLastConversation(storage, "s");
  assert.equal(loadLastConversation(storage, "s"), null);
});

test("redirect only a bare landing (the loop guard)", () => {
  const stored = { channelId: "dm-y", at: 1, pubkey: null };
  assert.equal(landingRedirectTarget({}, stored), "dm-y");
  assert.equal(landingRedirectTarget({ c: "dm-y" }, stored), null);
  assert.equal(landingRedirectTarget({ c: "other" }, stored), null);
  assert.equal(landingRedirectTarget({ view: "inbox" }, stored), null);
  assert.equal(landingRedirectTarget({ m: "msg" }, stored), null);
  assert.equal(landingRedirectTarget({}, null), null);
});

const base = {
  channelId: "dm-y",
  storedPubkey: null,
  selfPubkey: null,
  knownChannelIds: new Set(["dm-y", "general"]),
  hiddenDmIds: [],
  listSettled: false,
};

test("restore verdict: valid as soon as the (seeded) list has it", () => {
  assert.equal(restoreVerdict(base), "valid");
});

test("restore verdict: missing waits until the list settles, then is stale", () => {
  const missing = { ...base, channelId: "gone" };
  assert.equal(restoreVerdict(missing), "wait");
  assert.equal(restoreVerdict({ ...missing, listSettled: true }), "stale");
});

test("restore verdict: a hidden DM or another identity's entry is stale", () => {
  assert.equal(restoreVerdict({ ...base, hiddenDmIds: ["dm-y"] }), "stale");
  assert.equal(
    restoreVerdict({ ...base, storedPubkey: "alice", selfPubkey: "bob" }),
    "stale",
  );
  assert.equal(
    restoreVerdict({ ...base, storedPubkey: "alice", selfPubkey: "alice" }),
    "valid",
  );
});
