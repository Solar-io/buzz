import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * Draft persistence against a FAKE idb-keyval installed at the module seam,
 * the same pattern as `askCacheStorage.test.mjs`. The real one throws under
 * node (no IndexedDB), which pins the cold-start discipline but can never
 * observe what was actually WRITTEN — and "the draft reached storage" is the
 * whole claim this file makes.
 *
 * The clock is injected too. A debounce tested against the real timer either
 * sleeps (slow, flaky) or is not tested at all.
 */
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "idb-keyval": `
    const store = globalThis.__BUZZ_TEST_IDB__;
    function fail() {
      if (store.broken) { throw new Error("IndexedDB unavailable"); }
    }
    export async function get(key) {
      fail(); store.calls.push(["get", key]); return store.data.get(key);
    }
    export async function set(key, value) {
      fail(); store.calls.push(["set", key]); store.data.set(key, value);
    }
    export async function del(key) {
      fail(); store.calls.push(["del", key]); store.data.delete(key);
    }
    export async function keys() {
      fail(); store.calls.push(["keys"]); return Array.from(store.data.keys());
    }
    export async function delMany(list) {
      fail();
      store.calls.push(["delMany", list]);
      for (const key of list) { store.data.delete(key); }
    }
  `,
};

globalThis.__BUZZ_TEST_IDB__ = { data: new Map(), calls: [], broken: false };

const {
  CARD_DRAFT_DEBOUNCE_MS,
  CARD_DRAFT_KEY_PREFIX,
  CARD_DRAFT_TTL_MS,
  cardDraftKey,
  clearAllCardDrafts,
  clearCardDraft,
  createCardDraftWriter,
  loadCardDraft,
  saveCardDraft,
} = await import("./cardDraft.ts");

const store = globalThis.__BUZZ_TEST_IDB__;

function reset() {
  store.data = new Map();
  store.calls = [];
  store.broken = false;
}

after(() => {
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__BUZZ_TEST_IDB__;
});

const STATE = {
  index: 2,
  answers: {
    scope: { optionIds: ["web"] },
    extras: { optionIds: ["docs", "perf"] },
  },
  note: "keep the CLI as is",
};

/** A controllable clock for the debounce. */
function fakeTimers() {
  let nextHandle = 1;
  const queued = new Map();
  return {
    timers: {
      setTimeout(handler, ms) {
        const handle = nextHandle++;
        queued.set(handle, { handler, ms });
        return handle;
      },
      clearTimeout(handle) {
        queued.delete(handle);
      },
    },
    pending: () => queued.size,
    /** Fire every queued callback, as the real timer eventually would. */
    run() {
      const entries = Array.from(queued.values());
      queued.clear();
      for (const entry of entries) {
        entry.handler();
      }
    },
    delays: () => Array.from(queued.values()).map((entry) => entry.ms),
  };
}

test("a saved draft round-trips under its own key", async () => {
  reset();
  await saveCardDraft("card-1", STATE, 1000);
  assert.deepEqual(
    store.calls.map(([op]) => op),
    ["set"],
  );
  const key = cardDraftKey("card-1");
  assert.ok(key.startsWith(CARD_DRAFT_KEY_PREFIX), key);
  assert.ok(store.data.has(key), "the draft must reach storage");
  const loaded = await loadCardDraft("card-1", 1000);
  assert.equal(loaded.cardId, "card-1");
  assert.equal(loaded.index, 2);
  assert.equal(loaded.note, "keep the CLI as is");
  assert.deepEqual(loaded.answers.extras, { optionIds: ["docs", "perf"] });
});

test("drafts for two cards do not see each other", async () => {
  reset();
  await saveCardDraft("card-1", STATE, 1000);
  await saveCardDraft("card-2", { index: 0, answers: {}, note: "other" }, 1000);
  assert.equal(
    (await loadCardDraft("card-1", 1000)).note,
    "keep the CLI as is",
  );
  assert.equal((await loadCardDraft("card-2", 1000)).note, "other");
  await clearCardDraft("card-1");
  assert.equal(await loadCardDraft("card-1", 1000), null);
  assert.ok(await loadCardDraft("card-2", 1000), "card-2 must survive");
});

test("a draft past its TTL is dropped rather than restored", async () => {
  reset();
  await saveCardDraft("card-1", STATE, 0);
  // One millisecond inside the window still restores…
  assert.ok(await loadCardDraft("card-1", CARD_DRAFT_TTL_MS));
  // …one past it does not, and the stale row is swept.
  assert.equal(await loadCardDraft("card-1", CARD_DRAFT_TTL_MS + 1), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.data.has(cardDraftKey("card-1")), false);
});

test("a draft written by another version is ignored, not mis-read", async () => {
  reset();
  store.data.set(cardDraftKey("card-1"), {
    v: "v0",
    cardId: "card-1",
    index: 1,
    answers: {},
    note: "",
    at: 1000,
  });
  assert.equal(await loadCardDraft("card-1", 1000), null);
});

test("junk in the slot loads as no draft, never as a throw", async () => {
  reset();
  for (const junk of [null, 7, "nope", [], { v: "v1" }]) {
    store.data.set(cardDraftKey("card-junk"), junk);
    assert.equal(await loadCardDraft("card-junk", 1000), null);
  }
});

test("unavailable storage cold-starts on every path", async () => {
  reset();
  store.broken = true;
  assert.equal(await loadCardDraft("card-1", 1000), null);
  // None of these may reject: they run from render and from teardown.
  await saveCardDraft("card-1", STATE, 1000);
  await clearCardDraft("card-1");
  await clearAllCardDrafts();
});

test("sign-out clears EVERY card draft and nothing else", async () => {
  reset();
  await saveCardDraft("card-1", STATE, 1000);
  await saveCardDraft("card-2", STATE, 1000);
  // A draft key from a hypothetical other version — prefix-matched, so the
  // sweep must take it too: an unsent answer is private whoever wrote it.
  store.data.set(`${CARD_DRAFT_KEY_PREFIX}v0:card-3`, { v: "v0" });
  store.data.set("asks:v2", { asks: [] });
  store.data.set("timeline:v2:ch-1", { messages: [] });

  await clearAllCardDrafts();

  assert.deepEqual(Array.from(store.data.keys()).sort(), [
    "asks:v2",
    "timeline:v2:ch-1",
  ]);
});

test("the debounced writer collapses a burst into ONE write", async () => {
  reset();
  const clock = fakeTimers();
  const writes = [];
  const writer = createCardDraftWriter("card-1", {
    timers: clock.timers,
    write: (id, state) => writes.push([id, state.index]),
  });

  writer.schedule({ ...STATE, index: 0 });
  writer.schedule({ ...STATE, index: 1 });
  writer.schedule({ ...STATE, index: 2 });
  assert.deepEqual(writes, [], "nothing is written before the window closes");
  assert.equal(clock.pending(), 1, "a burst leaves exactly one timer armed");
  assert.deepEqual(clock.delays(), [CARD_DRAFT_DEBOUNCE_MS]);

  clock.run();
  // ONE write, carrying the LAST state — a throttle would have written the
  // first, and no debounce at all would have written three.
  assert.deepEqual(writes, [["card-1", 2]]);

  clock.run();
  assert.deepEqual(writes, [["card-1", 2]], "an empty window writes nothing");
});

test("flush writes the pending draft immediately, once", () => {
  reset();
  const clock = fakeTimers();
  const writes = [];
  const writer = createCardDraftWriter("card-1", {
    timers: clock.timers,
    write: (id, state) => writes.push([id, state.index]),
  });
  writer.schedule({ ...STATE, index: 3 });
  writer.flush();
  assert.deepEqual(writes, [["card-1", 3]]);
  // The armed timer was cancelled, so the window closing writes nothing more.
  clock.run();
  assert.deepEqual(writes, [["card-1", 3]]);
  // Flushing with nothing pending is a no-op.
  writer.flush();
  assert.deepEqual(writes, [["card-1", 3]]);
});

test("cancel stops a pending write from resurrecting a published draft", () => {
  // The order that matters: submit -> cancel -> delete. Without cancel the
  // debounced write lands AFTER the delete and the draft comes back for an
  // interview that has already been answered.
  reset();
  const clock = fakeTimers();
  const writes = [];
  const writer = createCardDraftWriter("card-1", {
    timers: clock.timers,
    write: (id, state) => writes.push([id, state.index]),
  });
  writer.schedule({ ...STATE, index: 3 });
  writer.cancel();
  clock.run();
  assert.deepEqual(writes, []);
  // And a flush after a cancel has nothing to write either.
  writer.flush();
  assert.deepEqual(writes, []);
});

test("the default writer really reaches storage", async () => {
  // The seam above makes every other test observe a FAKE write. This one
  // uses the module's own default `write`, so a writer wired to nothing
  // would be caught here rather than shipping green.
  reset();
  const clock = fakeTimers();
  const writer = createCardDraftWriter("card-live", { timers: clock.timers });
  writer.schedule({ index: 1, answers: { q: { optionIds: ["a"] } }, note: "" });
  clock.run();
  await new Promise((resolve) => setImmediate(resolve));
  const stored = store.data.get(cardDraftKey("card-live"));
  assert.ok(stored, "the default writer must actually persist");
  assert.equal(stored.index, 1);
  assert.deepEqual(stored.answers.q, { optionIds: ["a"] });
});
