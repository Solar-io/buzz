import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LINKS_SEED_PREFIX,
  createLinksStore,
  readLinksSeed,
} from "./linksStore.ts";
import {
  addSidebarShortcut,
  emptyShortcutBlob,
  serializeShortcutBlob,
  sidebarShortcuts,
} from "./shortcutBlob.ts";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

function blobWith(label) {
  const result = addSidebarShortcut(emptyShortcutBlob(), {
    url: `https://${label}.test/`,
    label,
    mode: "overlay",
  });
  assert.equal(result.ok, true);
  return result.blob;
}

function harness({ storage = memoryStorage() } = {}) {
  const subs = [];
  const store = createLinksStore({
    subscribe: (filter, options) => {
      const sub = { filter, options, closed: false };
      subs.push(sub);
      return () => {
        sub.closed = true;
      };
    },
    // "Ciphertext" is the plaintext itself; failures are marked explicitly.
    decrypt: async (content) => {
      if (content === "UNREADABLE") throw new Error("nope");
      return content;
    },
    storage: () => storage,
  });
  return { store, subs, storage };
}

function event(blob, createdAt) {
  return {
    pubkey: "me",
    content: serializeShortcutBlob(blob),
    created_at: createdAt,
    tags: [["d", "shortcut-bar"]],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("seed paints before the relay answers, keyed per pubkey", () => {
  const storage = memoryStorage({
    [`${LINKS_SEED_PREFIX}me`]: serializeShortcutBlob(blobWith("Stash")),
    [`${LINKS_SEED_PREFIX}other`]: serializeShortcutBlob(blobWith("Theirs")),
  });
  const { store } = harness({ storage });
  store.acquire("s1", "me", true);
  const state = store.getSnapshot();
  assert.equal(state.loaded, false);
  assert.deepEqual(
    sidebarShortcuts(state.blob).map((s) => s.label),
    ["Stash"],
    "own seed only — never another identity's",
  );
});

test("a decrypted relay copy replaces the seed and is written back as the new seed", async () => {
  const { store, subs, storage } = harness();
  store.acquire("s1", "me", true);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].options.priority, "critical");
  subs[0].options.onEvent(event(blobWith("Grafana"), 100));
  subs[0].options.onEose();
  await flush();
  const state = store.getSnapshot();
  assert.equal(state.loaded, true);
  assert.equal(state.maxFetched, 100);
  assert.deepEqual(
    sidebarShortcuts(state.blob).map((s) => s.label),
    ["Grafana"],
  );
  assert.deepEqual(
    sidebarShortcuts(readLinksSeed(storage, "me")).map((s) => s.label),
    ["Grafana"],
  );
});

test("relay with no stored blob drops a stale seed at EOSE", () => {
  const storage = memoryStorage({
    [`${LINKS_SEED_PREFIX}me`]: serializeShortcutBlob(blobWith("Old")),
  });
  const { store, subs } = harness({ storage });
  store.acquire("s1", "me", true);
  subs[0].options.onEose();
  assert.deepEqual(sidebarShortcuts(store.getSnapshot().blob), []);
});

test("an undecryptable copy is blocked, and not seeded", async () => {
  const { store, subs, storage } = harness();
  store.acquire("s1", "me", true);
  subs[0].options.onEvent({
    ...event(emptyShortcutBlob(), 5),
    content: "UNREADABLE",
  });
  await flush();
  assert.equal(store.getSnapshot().blocked, true);
  assert.equal(readLinksSeed(storage, "me"), null);
});

test("many readers share ONE subscription; the last release closes it", () => {
  const { store, subs } = harness();
  const a = store.acquire("s1", "me", true);
  const b = store.acquire("s1", "me", true);
  const c = store.acquire("s1", "me", true);
  assert.equal(subs.length, 1, "no re-subscribe per reader / link open");
  a();
  b();
  assert.equal(subs[0].closed, false);
  c();
  assert.equal(subs[0].closed, true);
});

test("switching identity replaces the subscription and the state", () => {
  const storage = memoryStorage({
    [`${LINKS_SEED_PREFIX}bob`]: serializeShortcutBlob(blobWith("Bob")),
  });
  const { store, subs } = harness({ storage });
  store.acquire("s1", "me", true);
  store.acquire("s1", "bob", true);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].closed, true);
  assert.equal(store.getSnapshot().pubkey, "bob");
  assert.deepEqual(
    sidebarShortcuts(store.getSnapshot().blob).map((s) => s.label),
    ["Bob"],
  );
});

test("an older event never replaces a newer one", async () => {
  const { store, subs } = harness();
  store.acquire("s1", "me", true);
  subs[0].options.onEvent(event(blobWith("New"), 200));
  subs[0].options.onEvent(event(blobWith("Old"), 100));
  await flush();
  assert.deepEqual(
    sidebarShortcuts(store.getSnapshot().blob).map((s) => s.label),
    ["New"],
  );
});
