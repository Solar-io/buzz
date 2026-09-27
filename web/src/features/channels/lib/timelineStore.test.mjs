import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

/**
 * The timeline store against a FAKE idb-keyval installed at the module seam
 * (the askCacheStorage.test.mjs pattern): a Map plus a call log, so the
 * tests can count disk writes and see evictions. Background-sync plan T6/T9.
 */
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "idb-keyval": `
    const store = globalThis.__BUZZ_TEST_IDB__;
    export async function get(key) {
      store.calls.push(["get", key]);
      return store.data.get(key);
    }
    export async function set(key, value) {
      store.calls.push(["set", key]);
      store.data.set(key, value);
    }
    export async function del(key) {
      store.calls.push(["del", key]);
      store.data.delete(key);
    }
  `,
};
globalThis.__BUZZ_TEST_IDB__ = { data: new Map(), calls: [] };

const { createTimelineStore, INDEX_KEY, syncCursor } = await import(
  "./timelineStore.ts"
);
const { cacheKey } = await import("./timelineCache.ts");

const idb = globalThis.__BUZZ_TEST_IDB__;

after(() => {
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__BUZZ_TEST_IDB__;
});

beforeEach(() => {
  idb.data = new Map();
  idb.calls = [];
});

function ev(id, createdAt, channel = "chan", overrides = {}) {
  return {
    id,
    kind: 9,
    pubkey: "bb",
    created_at: createdAt,
    content: `c-${id}`,
    tags: [["h", channel]],
    sig: "ff",
    ...overrides,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setsOf(key) {
  return idb.calls.filter(([op, k]) => op === "set" && k === key).length;
}

test("harness: a stored entry is readable back through load()", async () => {
  idb.data.set(cacheKey("seeded"), {
    messages: [],
    reactions: new Map(),
    cursor: 42,
    historyExhausted: false,
    deletedIds: [],
  });
  const store = createTimelineStore({ flushMs: 5 });
  const entry = await store.load("seeded");
  assert.equal(entry.cursor, 42);
  assert.equal(store.peek("seeded"), entry);
});

test("T6 owner guard: warm writes for the OWNED channel are dropped", async () => {
  const store = createTimelineStore({ flushMs: 5 });
  await store.load("open");
  store.setOwner("open");
  store.apply("open", ev("w1", 100, "open"), { source: "activity" });
  assert.equal(store.peek("open").messages.length, 0);
  // The owner's own sync path still writes.
  store.apply("open", ev("s1", 100, "open"), { source: "timeline" });
  assert.equal(store.peek("open").messages.length, 1);
  // Released: warm writes flow again.
  store.releaseOwner("open");
  store.apply("open", ev("w2", 200, "open"), { source: "activity" });
  assert.deepEqual(
    store.peek("open").messages.map((m) => m.id),
    ["s1", "w2"],
  );
});

test("T6 warm write to an unknown channel loads IDB first and keeps its history", async () => {
  idb.data.set(cacheKey("known"), {
    messages: [
      {
        id: "disk",
        channelId: "known",
        authorPubkey: "aa",
        createdAt: 500,
        content: "x",
        kind: 9,
        rootId: null,
        replyToId: null,
        mentionPubkeys: [],
        imetaByUrl: new Map(),
        linkPreviews: [],
        card: null,
        edited: false,
        deleted: false,
      },
    ],
    reactions: new Map(),
    cursor: 500,
    historyExhausted: true,
    deletedIds: [],
  });
  const store = createTimelineStore({ flushMs: 5 });
  store.apply("known", ev("warm", 600, "known"), { source: "activity" });
  assert.equal(store.peek("known"), null, "no entry invented synchronously");
  await sleep(1);
  const entry = store.peek("known");
  assert.deepEqual(
    entry.messages.map((m) => m.id),
    ["disk", "warm"],
  );
  assert.equal(entry.cursor, 500, "warm write never advances the cursor");
});

test("T6 LRU: the 9th entry evicts the least-recently-used (capacity 8)", async () => {
  const store = createTimelineStore({ flushMs: 5 });
  for (let i = 1; i <= 8; i++) {
    await store.load(`c${i}`);
  }
  // Touch c1 so c2 becomes the oldest.
  store.apply("c1", ev("x", 10, "c1"), { source: "timeline" });
  await store.load("c9");
  assert.equal(store.memoryIds().length, 8);
  assert.equal(store.peek("c2"), null);
  assert.notEqual(store.peek("c1"), null);
  assert.notEqual(store.peek("c9"), null);
});

test("T6 LRU never evicts the owned channel", async () => {
  const store = createTimelineStore({ flushMs: 5 });
  await store.load("owned");
  store.setOwner("owned");
  for (let i = 1; i <= 8; i++) {
    await store.load(`c${i}`);
  }
  assert.notEqual(store.peek("owned"), null);
  assert.equal(store.peek("c1"), null);
  assert.equal(store.memoryIds().length, 8);
});

test("T6 warm-only entries are capped at 60 rows; opened entries are not", async () => {
  const store = createTimelineStore({ flushMs: 5 });
  await store.load("warm");
  for (let i = 0; i < 75; i++) {
    store.apply("warm", ev(`w${i}`, 1000 + i, "warm"), { source: "activity" });
  }
  const warm = store.peek("warm");
  assert.equal(warm.messages.length, 60);
  assert.equal(warm.messages[0].id, "w15", "the NEWEST 60 are kept");

  await store.load("opened");
  store.setOwner("opened");
  for (let i = 0; i < 75; i++) {
    store.apply("opened", ev(`o${i}`, 1000 + i, "opened"), {
      source: "timeline",
    });
  }
  assert.equal(store.peek("opened").messages.length, 75);
});

test("T6 write-behind coalesces 5 applies into ONE set", async () => {
  const store = createTimelineStore({ flushMs: 20 });
  await store.load("busy");
  for (let i = 0; i < 5; i++) {
    store.apply("busy", ev(`b${i}`, 100 + i, "busy"), { source: "timeline" });
  }
  assert.equal(setsOf(cacheKey("busy")), 0, "nothing written before the debounce");
  await sleep(60);
  assert.equal(setsOf(cacheKey("busy")), 1);
  assert.equal(idb.data.get(cacheKey("busy")).messages.length, 5);
});

test("T6 index eviction keeps the 40 most recently written entries", async () => {
  let clock = 0;
  const store = createTimelineStore({ flushMs: 1, now: () => ++clock });
  for (let i = 0; i < 45; i++) {
    const id = `d${i}`;
    await store.load(id);
    store.apply(id, ev(`m${i}`, 10, id), { source: "timeline" });
    await store.flushAll();
  }
  const index = idb.data.get(INDEX_KEY);
  assert.equal(Object.keys(index).length, 40);
  for (let i = 0; i < 5; i++) {
    assert.equal(idb.data.has(cacheKey(`d${i}`)), false, `d${i} evicted`);
  }
  for (let i = 5; i < 45; i++) {
    assert.equal(idb.data.has(cacheKey(`d${i}`)), true, `d${i} kept`);
  }
});

test("T9 store side: a warm apply for another channel lands with the cursor untouched", async () => {
  const store = createTimelineStore({ flushMs: 5 });
  await store.load("x");
  store.update("x", (e) => ({ ...e, cursor: 1000 }));
  store.apply("x", ev("late", 1500, "x"), { source: "dms" });
  store.apply("x", ev("old", 900, "x"), { source: "unread" });
  assert.deepEqual(
    store.peek("x").messages.map((m) => m.id),
    ["late"],
  );
  assert.equal(store.peek("x").cursor, 1000);
});

test("syncCursor: synced entries use the watermark, never-synced warm entries their oldest row", () => {
  assert.equal(syncCursor(null), null);
  assert.equal(
    syncCursor({ cursor: 0, messages: [] }),
    null,
    "cold: first page",
  );
  assert.equal(syncCursor({ cursor: 0, messages: [{ createdAt: 70 }] }), 70);
  assert.equal(syncCursor({ cursor: 90, messages: [{ createdAt: 70 }] }), 90);
});

test("subscribers see every committed change", async () => {
  const store = createTimelineStore({ flushMs: 5 });
  await store.load("s");
  const seen = [];
  const off = store.subscribe("s", (e) => seen.push(e.messages.length));
  store.apply("s", ev("a", 1, "s"), { source: "timeline" });
  store.apply("s", ev("a", 1, "s"), { source: "activity" }); // no-op repeat
  off();
  store.apply("s", ev("b", 2, "s"), { source: "timeline" });
  assert.deepEqual(seen, [1]);
});
