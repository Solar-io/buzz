import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { isFavorite, loadChannelPrefs, setFavorite } from "./channelPrefs.ts";
import {
  FAVORITES_D_TAG,
  KIND_FAVORITES,
  blobFromPrefs,
  mergeFavorites,
  parseFavoritesBlob,
  planFavoritesSync,
} from "./favoritesSync.ts";
import { createFavoritesSync } from "./favoritesSyncEngine.ts";

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

const ch = (id, at = 0) => ({ kind: "channel", id, at });
const link = (id, at = 0) => ({ kind: "link", id, at });
const blob = (favorites, removed = []) => ({ v: 1, favorites, removed });
const ids = (b) => b.favorites.map((f) => `${f.kind}:${f.id}`);

// --- merge ---------------------------------------------------------------

test("union: remote order first, then local-only additions in local order", () => {
  const remote = blob([ch("b", 10), ch("a", 20)]);
  const local = blob([ch("a", 0), ch("c", 0), link("sc:1", 5)]);
  const merged = mergeFavorites(remote, local);
  assert.deepEqual(ids(merged), [
    "channel:b",
    "channel:a",
    "channel:c",
    "link:sc:1",
  ]);
  // The newer stamp is the one kept.
  assert.equal(merged.favorites[1].at, 20);
});

test("removal propagates: a newer tombstone drops a favorite the other side still has", () => {
  // Device A unfavorited `a` at t=50; this (stale) device still has it from t=10.
  const remote = blob([ch("b", 10)], [ch("a", 50)]);
  const local = blob([ch("a", 10), ch("b", 10)]);
  const plan = planFavoritesSync(remote, local);
  assert.deepEqual(ids(plan.merged), ["channel:b"]);
  assert.equal(plan.localChanged, true, "the stale device drops it");
  assert.equal(plan.publish, false, "and has nothing new to tell the relay");
  // A pre-sync favorite (no stamp, 0) loses to any explicit removal too.
  assert.deepEqual(
    ids(mergeFavorites(blob([], [ch("a", 1)]), blob([ch("a", 0)]))),
    [],
  );
});

test("a re-favorite newer than the tombstone wins, and a tie keeps the favorite", () => {
  const remote = blob([], [ch("a", 50)]);
  assert.deepEqual(ids(mergeFavorites(remote, blob([ch("a", 60)]))), [
    "channel:a",
  ]);
  assert.deepEqual(ids(mergeFavorites(remote, blob([ch("a", 50)]))), [
    "channel:a",
  ]);
  // The surviving favorite's tombstone is gone from the merged set.
  assert.deepEqual(mergeFavorites(remote, blob([ch("a", 60)])).removed, []);
});

test("first sync, empty remote: every local favorite survives and is published", () => {
  const local = blob([ch("x"), ch("y"), link("sc:2")]);
  const plan = planFavoritesSync(null, local);
  assert.deepEqual(ids(plan.merged), ["channel:x", "channel:y", "link:sc:2"]);
  assert.equal(plan.localChanged, false);
  assert.equal(plan.publish, true);
  // Same for a relay copy that exists but is empty.
  const emptyRemote = planFavoritesSync(blob([]), local);
  assert.deepEqual(ids(emptyRemote.merged), ids(plan.merged));
  assert.equal(emptyRemote.publish, true);
  // Nothing on either side: nothing to publish.
  assert.equal(planFavoritesSync(null, blob([])).publish, false);
});

test("first sync, empty local: the remote set lands on this device as-is", () => {
  const remote = blob([ch("p", 7), ch("q", 8)], [ch("z", 9)]);
  const plan = planFavoritesSync(remote, blob([]));
  assert.deepEqual(ids(plan.merged), ["channel:p", "channel:q"]);
  assert.deepEqual(plan.merged.removed, [ch("z", 9)]);
  assert.equal(plan.localChanged, true);
  assert.equal(plan.publish, false);
});

test("a future blob version is refused, not read", () => {
  assert.deepEqual(parseFavoritesBlob({ v: 2, favorites: [] }), {
    ok: false,
    reason: "future-version",
  });
  assert.equal(parseFavoritesBlob("nope").ok, false);
  const parsed = parseFavoritesBlob({
    v: 1,
    favorites: [ch("a", 1), { kind: "bogus", id: "x", at: 1 }, ch("a", 2)],
    removed: [],
  });
  assert.deepEqual(parsed, { ok: true, blob: blob([ch("a", 1)]) });
});

test("channelPrefs stamps adds and tombstones removals", () => {
  let prefs = setFavorite(
    loadChannelPrefs(),
    { kind: "channel", id: "a" },
    true,
    100,
  );
  prefs = setFavorite(prefs, { kind: "channel", id: "b" }, true, 110);
  prefs = setFavorite(prefs, { kind: "channel", id: "a" }, false, 120);
  assert.deepEqual(
    blobFromPrefs(loadChannelPrefs()),
    blob([ch("b", 110)], [ch("a", 120)]),
  );
  prefs = setFavorite(prefs, { kind: "channel", id: "a" }, true, 130);
  assert.deepEqual(
    blobFromPrefs(loadChannelPrefs()),
    blob([ch("b", 110), ch("a", 130)]),
    "re-adding lifts the tombstone",
  );
});

// --- engine --------------------------------------------------------------

/**
 * A fake relay + clock for the engine: plaintext "encryption" (JSON passes
 * through), a scripted publish verdict, and timers run by hand.
 */
function harness({ verdicts = [], stored = null } = {}) {
  const pubkey = "f".repeat(64);
  const published = [];
  const timers = [];
  let handlers = null;
  let synced = 0;
  let nextId = 0;
  const engine = createFavoritesSync({
    pubkey,
    subscribe: (filter, h) => {
      assert.deepEqual(filter["#d"], [FAVORITES_D_TAG]);
      handlers = h;
      return () => {};
    },
    publish: async (event) => {
      published.push(event);
      return verdicts.shift() ?? { ok: true, message: "" };
    },
    decrypt: async (text) => text,
    encrypt: async (text) => text,
    sign: async (template) => ({ ...template, pubkey, id: `e${nextId++}` }),
    loadPrefs: loadChannelPrefs,
    savePrefs: (prefs) =>
      globalThis.localStorage.setItem(
        "buzz.channel-prefs.v1",
        JSON.stringify(prefs),
      ),
    onLocalSynced: () => {
      synced += 1;
    },
    schedule: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    nowMs: () => 1_700_000_000_000,
  });
  const storedEvent = (b, created_at = 1_600_000_000) => ({
    id: `r${created_at}`,
    pubkey,
    kind: KIND_FAVORITES,
    created_at,
    tags: [["d", FAVORITES_D_TAG]],
    content: JSON.stringify(b),
  });
  if (stored) {
    handlers.onEvent(storedEvent(stored));
  }
  return {
    engine,
    published,
    storedEvent,
    emit: (event) => handlers.onEvent(event),
    eose: () => handlers.onEose(),
    synced: () => synced,
    /** Run every live timer (one round), then drain the engine's chain. */
    async tick() {
      await engine.idle();
      const due = timers.splice(0).filter((t) => t.live);
      for (const t of due) {
        t.fn();
      }
      await engine.idle();
      return due.map((t) => t.ms);
    },
  };
}

function seedLocal(...favorites) {
  let prefs = loadChannelPrefs();
  for (const id of favorites) {
    prefs = setFavorite(prefs, { kind: "channel", id }, true, 0);
  }
  // Pre-sync shape: no stamps at all.
  globalThis.localStorage.setItem(
    "buzz.channel-prefs.v1",
    JSON.stringify({ favorites: prefs.favorites, muted: [] }),
  );
}

test("engine: first sync merges a remote set into local favorites and publishes the union", async () => {
  seedLocal("local-1");
  const h = harness({ stored: blob([ch("remote-1", 5)]) });
  h.eose();
  await h.tick();
  const ids_ = loadChannelPrefs().favorites.map((f) => f.id);
  assert.deepEqual(
    ids_,
    ["remote-1", "local-1"],
    "nothing wiped, remote first",
  );
  assert.equal(h.synced(), 1);
  assert.equal(h.published.length, 1);
  assert.deepEqual(
    JSON.parse(h.published[0].content).favorites.map((f) => f.id),
    ["remote-1", "local-1"],
  );
  assert.ok(h.published[0].created_at > 1_600_000_000);
  // The relay echoes our own event back: a no-op, never a second publish.
  h.emit({ ...h.published[0] });
  await h.tick();
  assert.equal(h.published.length, 1);
});

test("engine: a refused publish keeps local favorites and retries with backoff", async () => {
  seedLocal("keep-me");
  const h = harness({
    verdicts: [
      { ok: false, message: "auth-required: not authenticated" },
      { ok: false, message: "timeout" },
    ],
  });
  h.eose();
  assert.deepEqual(await h.tick(), [0], "the boot publish fires at once");
  assert.equal(h.published.length, 1);
  assert.equal(h.engine.status(), "retrying");
  assert.deepEqual(
    loadChannelPrefs().favorites.map((f) => f.id),
    ["keep-me"],
    "the refusal touched nothing local",
  );
  assert.deepEqual(await h.tick(), [5_000]);
  assert.equal(h.published.length, 2);
  assert.deepEqual(await h.tick(), [10_000], "doubles");
  assert.equal(h.published.length, 3);
  assert.equal(h.engine.status(), "synced");
  assert.deepEqual(await h.tick(), [], "and stops once accepted");
});

test("engine: a removal made on another device lands live", async () => {
  seedLocal("a", "b");
  const h = harness({ stored: blob([ch("a", 5), ch("b", 5)]) });
  h.eose();
  await h.tick();
  assert.equal(h.published.length, 0, "already in sync");
  h.emit(h.storedEvent(blob([ch("b", 5)], [ch("a", 9)]), 1_600_000_100));
  await h.tick();
  const prefs = loadChannelPrefs();
  assert.equal(isFavorite(prefs, { kind: "channel", id: "a" }), false);
  assert.equal(isFavorite(prefs, { kind: "channel", id: "b" }), true);
  assert.equal(h.published.length, 0);
});

test("engine: a local unfavorite publishes a tombstone", async () => {
  seedLocal("a", "b");
  const h = harness({ stored: blob([ch("a", 5), ch("b", 5)]) });
  h.eose();
  await h.tick();
  setFavorite(loadChannelPrefs(), { kind: "channel", id: "a" }, false, 99);
  h.engine.noteLocalChange();
  await h.tick();
  assert.equal(h.published.length, 1);
  const sent = JSON.parse(h.published[0].content);
  assert.deepEqual(
    sent.favorites.map((f) => f.id),
    ["b"],
  );
  assert.deepEqual(sent.removed, [ch("a", 99)]);
});

test("engine: an unreadable relay copy switches sync off instead of overwriting it", async () => {
  seedLocal("mine");
  const h = harness();
  h.emit({ ...h.storedEvent(blob([])), content: "not json" });
  h.eose();
  await h.tick();
  assert.equal(h.engine.status(), "off");
  assert.equal(h.published.length, 0);
  assert.deepEqual(
    loadChannelPrefs().favorites.map((f) => f.id),
    ["mine"],
  );
});

// --- adversarial QA (2026-10-01) ----------------------------------------

test("clock skew: an unfavorite on a device whose clock runs BEHIND still beats the add it saw", () => {
  // Device A (clock 10 min fast) added `x` at 1_000_600; device B, with a
  // correct clock, synced that set and unfavorited `x` at 1_000_000.
  globalThis.localStorage.setItem(
    "buzz.channel-prefs.v1",
    JSON.stringify({
      favorites: [{ kind: "channel", id: "x" }],
      favoriteAt: { "channel:x": 1_000_600 },
      muted: [],
    }),
  );
  setFavorite(
    loadChannelPrefs(),
    { kind: "channel", id: "x" },
    false,
    1_000_000,
  );
  const onB = blobFromPrefs(loadChannelPrefs());
  // A stale A still holds its add; the merge must keep B's removal.
  const merged = mergeFavorites(onB, blob([ch("x", 1_000_600)]));
  assert.deepEqual(ids(merged), [], "the removal is not resurrected");
});

test("clock skew: a re-favorite on a device whose clock runs BEHIND still beats the tombstone it saw", () => {
  globalThis.localStorage.setItem(
    "buzz.channel-prefs.v1",
    JSON.stringify({
      favorites: [],
      removed: [{ kind: "channel", id: "x", at: 2_000_600 }],
      muted: [],
    }),
  );
  setFavorite(
    loadChannelPrefs(),
    { kind: "channel", id: "x" },
    true,
    2_000_000,
  );
  const onB = blobFromPrefs(loadChannelPrefs());
  const merged = mergeFavorites(blob([], [ch("x", 2_000_600)]), onB);
  assert.deepEqual(ids(merged), ["channel:x"], "the re-add is not lost");
});

test("a relay entry without a stamp merges as time 0 instead of being dropped and overwritten", async () => {
  seedLocal("mine");
  const h = harness({
    stored: {
      v: 1,
      favorites: [{ kind: "channel", id: "theirs" }],
      removed: [],
    },
  });
  h.eose();
  await h.tick();
  assert.deepEqual(
    loadChannelPrefs().favorites.map((f) => f.id),
    ["theirs", "mine"],
  );
  assert.deepEqual(
    JSON.parse(h.published[0].content).favorites.map((f) => f.id),
    ["theirs", "mine"],
    "the publish does not drop the relay's entry",
  );
});

test("engine: a malformed relay copy (favorites not an array) never publishes over it", async () => {
  seedLocal("mine");
  const h = harness();
  h.emit({
    ...h.storedEvent(blob([])),
    content: JSON.stringify({ v: 1, favorites: "x" }),
  });
  h.eose();
  await h.tick();
  setFavorite(loadChannelPrefs(), { kind: "channel", id: "later" }, true, 50);
  h.engine.noteLocalChange();
  await h.tick();
  assert.equal(h.engine.status(), "off");
  assert.equal(h.published.length, 0);
  assert.deepEqual(
    loadChannelPrefs().favorites.map((f) => f.id),
    ["mine", "later"],
  );
});

test("engine: a stale device whose publish was refused does not resurrect a removal that lands meanwhile", async () => {
  // This device added `x` at t=10, went offline; another device removed it at t=20.
  globalThis.localStorage.setItem(
    "buzz.channel-prefs.v1",
    JSON.stringify({
      favorites: [
        { kind: "channel", id: "x" },
        { kind: "channel", id: "y" },
      ],
      favoriteAt: { "channel:x": 10, "channel:y": 10 },
      muted: [],
    }),
  );
  const h = harness({
    stored: blob([ch("y", 10)]),
    verdicts: [{ ok: false, message: "timeout" }],
  });
  h.eose();
  await h.tick(); // publishes x+y, refused
  assert.equal(h.engine.status(), "retrying");
  h.emit(h.storedEvent(blob([ch("y", 10)], [ch("x", 20)]), 1_600_000_100));
  await h.tick(); // reconcile, then the retry
  assert.deepEqual(
    loadChannelPrefs().favorites.map((f) => f.id),
    ["y"],
  );
  // The retry finds the relay already holds the merge: nothing re-sent, so
  // the refused copy carrying `x` is never published again.
  assert.equal(h.published.length, 1, "no publish resurrects x");
  assert.equal(h.engine.status(), "synced");
  assert.deepEqual(await h.tick(), [], "and no retry is left pending");
});

test("engine: two devices publishing at once converge on the union", async () => {
  seedLocal("a");
  const h = harness({ stored: blob([ch("a", 0)]) });
  h.eose();
  await h.tick();
  setFavorite(loadChannelPrefs(), { kind: "channel", id: "mine" }, true, 100);
  h.engine.noteLocalChange();
  await h.tick();
  const ours = h.published.at(-1);
  // The other device's simultaneous publish wins the coordinate (newer created_at).
  h.emit(
    h.storedEvent(blob([ch("a", 0), ch("theirs", 100)]), ours.created_at + 1),
  );
  await h.tick();
  assert.deepEqual(
    loadChannelPrefs()
      .favorites.map((f) => f.id)
      .sort(),
    ["a", "mine", "theirs"],
  );
  const last = JSON.parse(h.published.at(-1).content);
  assert.deepEqual(last.favorites.map((f) => f.id).sort(), [
    "a",
    "mine",
    "theirs",
  ]);
  assert.ok(h.published.at(-1).created_at > ours.created_at + 1);
});
