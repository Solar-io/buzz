import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  forgetChannel,
  isMuted,
  isStarred,
  loadChannelPrefs,
  toggleMuted,
  toggleStarred,
} from "./channelPrefs.ts";
import {
  mergePresence,
  presenceFromEvent,
  presenceDotClass,
  statusFromContent,
} from "./presence.ts";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

test("star/mute toggles persist and round-trip", () => {
  let prefs = loadChannelPrefs();
  assert.equal(isStarred(prefs, "a"), false);
  prefs = toggleStarred(prefs, "a");
  assert.equal(isStarred(prefs, "a"), true);
  assert.equal(isStarred(loadChannelPrefs(), "a"), true, "persisted");
  prefs = toggleStarred(prefs, "a");
  assert.equal(isStarred(prefs, "a"), false, "toggle off");
  prefs = toggleMuted(prefs, "a");
  assert.equal(isMuted(prefs, "a"), true);
  // Star and mute are independent.
  prefs = toggleStarred(prefs, "a");
  assert.equal(isMuted(prefs, "a"), true);
  assert.equal(isStarred(prefs, "a"), true);
});

test("forgetChannel strips both lists", () => {
  let prefs = toggleStarred(loadChannelPrefs(), "a");
  prefs = toggleMuted(prefs, "a");
  prefs = toggleMuted(prefs, "b");
  const next = forgetChannel(prefs, "a");
  assert.equal(isStarred(next, "a"), false);
  assert.equal(isMuted(next, "a"), false);
  assert.equal(isMuted(next, "b"), true, "other channels untouched");
});

test("corrupted storage degrades to empty prefs", () => {
  globalThis.localStorage.setItem("buzz.channel-prefs.v1", "{oops");
  assert.deepEqual(loadChannelPrefs(), { starred: [], muted: [] });
  // Non-string entries are dropped.
  globalThis.localStorage.setItem(
    "buzz.channel-prefs.v1",
    JSON.stringify({ starred: [1, "ok"], muted: null }),
  );
  const prefs = loadChannelPrefs();
  assert.deepEqual(prefs.starred, ["ok"]);
  assert.deepEqual(prefs.muted, []);
});

function presenceEvent(overrides = {}) {
  return {
    kind: 20001,
    created_at: 1_787_800_000,
    tags: [],
    content: "online",
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    ...overrides,
  };
}

test("presence parses bare and legacy JSON statuses", () => {
  assert.equal(statusFromContent("online"), "online");
  assert.equal(statusFromContent('{"status":"away"}'), "away");
  assert.equal(statusFromContent("surfing"), "unknown");
  assert.equal(statusFromContent('{"broken"'), "unknown");
});

test("presenceFromEvent maps kind 20001 only; merge keeps the latest", () => {
  const entry = presenceFromEvent(presenceEvent());
  assert.equal(entry.status, "online");
  assert.equal(entry.pubkey, "a".repeat(64));
  assert.equal(presenceFromEvent(presenceEvent({ kind: 9 })), null);

  const older = { pubkey: "p", status: "online", updatedAt: 100 };
  const newer = { pubkey: "p", status: "away", updatedAt: 200 };
  let map = mergePresence(new Map(), older);
  const sameRef = mergePresence(map, { ...older, updatedAt: 50 });
  assert.equal(sameRef, map, "stale entry reuses the reference");
  map = mergePresence(map, newer);
  assert.equal(map.get("p").status, "away");
  assert.equal(presenceDotClass("online"), "bg-emerald-500");
});
