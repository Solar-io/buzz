import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  favoriteChannelIds,
  forgetChannel,
  isFavorite,
  isMuted,
  loadChannelPrefs,
  setFavorite,
  toggleFavorite,
  toggleMuted,
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

const PREFS_KEY = "buzz.channel-prefs.v1";
const channel = (id) => ({ kind: "channel", id });
const link = (id) => ({ kind: "link", id });

test("favorite/mute toggles persist and round-trip", () => {
  let prefs = loadChannelPrefs();
  assert.equal(isFavorite(prefs, channel("a")), false);
  prefs = toggleFavorite(prefs, channel("a"));
  assert.equal(isFavorite(prefs, channel("a")), true);
  assert.equal(isFavorite(loadChannelPrefs(), channel("a")), true, "persisted");
  prefs = toggleFavorite(prefs, channel("a"));
  assert.equal(isFavorite(prefs, channel("a")), false, "toggle off");
  prefs = toggleMuted(prefs, "a");
  assert.equal(isMuted(prefs, "a"), true);
  // Favorite and mute are independent.
  prefs = toggleFavorite(prefs, channel("a"));
  assert.equal(isMuted(prefs, "a"), true);
  assert.equal(isFavorite(prefs, channel("a")), true);
});

test("migration: a pre-favorites value loads its starred ids as channel favorites", () => {
  // Exactly the shape the old build wrote — no `favorites` key at all.
  globalThis.localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({ starred: ["general", "ops"], muted: ["noisy"] }),
  );
  const prefs = loadChannelPrefs();
  assert.deepEqual(prefs.favorites, [
    { kind: "channel", id: "general" },
    { kind: "channel", id: "ops" },
  ]);
  assert.deepEqual(prefs.muted, ["noisy"], "muted survives the migration");
  // The first write persists the new shape; reloading keeps the favorites
  // and no longer depends on `starred`.
  const next = toggleFavorite(prefs, link("sc:1"));
  const stored = JSON.parse(globalThis.localStorage.getItem(PREFS_KEY));
  assert.deepEqual(stored.favorites, [
    { kind: "channel", id: "general" },
    { kind: "channel", id: "ops" },
    { kind: "link", id: "sc:1" },
  ]);
  assert.deepEqual(stored.starred, ["general", "ops"], "back-compat mirror");
  assert.deepEqual(loadChannelPrefs(), next);
});

test("a stored favorites list wins over a stale starred mirror", () => {
  globalThis.localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({
      favorites: [{ kind: "link", id: "sc:2" }],
      starred: ["old"],
      muted: [],
    }),
  );
  assert.deepEqual(loadChannelPrefs().favorites, [
    { kind: "link", id: "sc:2" },
  ]);
});

test("favorites keep their add order across kinds; toggle-off keeps the rest in place", () => {
  let prefs = loadChannelPrefs();
  // A stream, a DM and a forum are all channel ids; a link is a shortcut id.
  prefs = toggleFavorite(prefs, channel("zeta-stream"));
  prefs = toggleFavorite(prefs, link("sc:4"));
  prefs = toggleFavorite(prefs, channel("dm-1"));
  prefs = toggleFavorite(prefs, channel("forum-1"));
  assert.deepEqual(prefs.favorites, [
    { kind: "channel", id: "zeta-stream" },
    { kind: "link", id: "sc:4" },
    { kind: "channel", id: "dm-1" },
    { kind: "channel", id: "forum-1" },
  ]);
  prefs = toggleFavorite(prefs, link("sc:4"));
  assert.deepEqual(prefs.favorites, [
    { kind: "channel", id: "zeta-stream" },
    { kind: "channel", id: "dm-1" },
    { kind: "channel", id: "forum-1" },
  ]);
  // A link and a channel with the same id are different favorites.
  prefs = toggleFavorite(prefs, link("dm-1"));
  assert.equal(isFavorite(prefs, link("dm-1")), true);
  assert.equal(isFavorite(prefs, channel("dm-1")), true);
  assert.deepEqual(favoriteChannelIds(prefs), [
    "zeta-stream",
    "dm-1",
    "forum-1",
  ]);
});

test("setFavorite is idempotent", () => {
  let prefs = setFavorite(loadChannelPrefs(), link("sc:1"), true);
  const same = setFavorite(prefs, link("sc:1"), true);
  assert.equal(same, prefs, "adding twice changes nothing");
  prefs = setFavorite(prefs, link("sc:1"), false);
  assert.deepEqual(prefs.favorites, []);
  assert.equal(setFavorite(prefs, link("sc:1"), false), prefs);
});

test("forgetChannel strips both lists", () => {
  let prefs = toggleFavorite(loadChannelPrefs(), channel("a"));
  prefs = toggleFavorite(prefs, link("a"));
  prefs = toggleMuted(prefs, "a");
  prefs = toggleMuted(prefs, "b");
  const next = forgetChannel(prefs, "a");
  assert.equal(isFavorite(next, channel("a")), false);
  assert.equal(isFavorite(next, link("a")), true, "a link is not a channel");
  assert.equal(isMuted(next, "a"), false);
  assert.equal(isMuted(next, "b"), true, "other channels untouched");
});

test("corrupted storage degrades to empty prefs", () => {
  globalThis.localStorage.setItem(PREFS_KEY, "{oops");
  assert.deepEqual(loadChannelPrefs(), { favorites: [], muted: [] });
  // Non-string starred entries are dropped.
  globalThis.localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({ starred: [1, "ok"], muted: null }),
  );
  let prefs = loadChannelPrefs();
  assert.deepEqual(prefs.favorites, [{ kind: "channel", id: "ok" }]);
  assert.deepEqual(prefs.muted, []);
  // Malformed and duplicate favorites are dropped, first occurrence kept.
  globalThis.localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({
      favorites: [
        { kind: "link", id: "sc:1" },
        { kind: "star", id: "x" },
        { kind: "channel" },
        "general",
        { kind: "channel", id: "b" },
        { kind: "link", id: "sc:1" },
      ],
    }),
  );
  prefs = loadChannelPrefs();
  assert.deepEqual(prefs.favorites, [
    { kind: "link", id: "sc:1" },
    { kind: "channel", id: "b" },
  ]);
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
