import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASKS_CACHE_CAP,
  asksCacheKey,
  fromCachedAsk,
  markCachedAnswered,
  mergeCachedAsks,
  toCachedAsk,
} from "./askCache.ts";
import { loadAsksCache, saveAsksCache } from "./askCache.ts";

const card = {
  title: "Ship the fix?",
  options: [
    { id: "0", label: "Yes", recommended: true },
    { id: "1", label: "No" },
  ],
};

const ask = (id, createdAt, overrides = {}) => ({
  id,
  channelId: "ch-1",
  channelType: "stream",
  authorPubkey: "aa".repeat(32),
  createdAt,
  card,
  ...overrides,
});

const empty = () => ({ asks: [], answered: {}, cursor: 0 });

test("the cache key is versioned — a shape change starts fresh, not corrupt", () => {
  assert.equal(asksCacheKey(), "asks:v1");
});

test("mergeCachedAsks dedupes by id, sorts newest first, and caps at 100", () => {
  let entry = mergeCachedAsks(empty(), [ask("b", 200), ask("a", 300)]);
  assert.deepEqual(
    entry.asks.map((a) => a.id),
    ["a", "b"],
  );
  // Same id again with a NEWER timestamp replaces the row (relay upsert).
  entry = mergeCachedAsks(entry, [ask("a", 400)]);
  assert.equal(entry.asks.length, 2);
  assert.equal(entry.asks[0].id, "a");
  assert.equal(entry.asks[0].createdAt, 400);
  assert.equal(entry.cursor, 400);

  const many = Array.from({ length: ASKS_CACHE_CAP + 25 }, (_, i) =>
    ask(`old-${i}`, i),
  );
  const capped = mergeCachedAsks(entry, many);
  assert.equal(capped.asks.length, ASKS_CACHE_CAP);
  // The OLDEST rows are the ones dropped, never the newest.
  assert.equal(capped.asks[0].id, "a");
  assert.ok(!capped.asks.some((a) => a.id === "old-0"));
});

test("merging nothing is a no-op returning the same reference", () => {
  const entry = empty();
  assert.equal(mergeCachedAsks(entry, []), entry);
});

test("re-merging the same asks returns the SAME entry, not a fresh copy", () => {
  // Identity-stability is load-bearing: the provider's persist effect
  // re-merges on every render whose deps moved — a merge that kept returning
  // a fresh object would feed its own setCache back into the effect and loop
  // forever. Content-equal merge MUST return the input entry.
  const first = mergeCachedAsks(empty(), [ask("a", 300), ask("b", 200)]);
  const again = mergeCachedAsks(first, [ask("a", 300), ask("b", 200)]);
  assert.equal(again, first);
  // A content change still produces a new entry.
  const changed = mergeCachedAsks(first, [ask("c", 500)]);
  assert.notEqual(changed, first);
});

test("markCachedAnswered records cardId → answerId and is idempotent", () => {
  let entry = mergeCachedAsks(empty(), [ask("a", 1), ask("b", 2)]);
  entry = markCachedAnswered(entry, "a", "answer-1");
  assert.equal(entry.answered.a, "answer-1");
  const same = markCachedAnswered(entry, "a", "answer-1");
  assert.equal(same, entry);
  const updated = markCachedAnswered(entry, "a", "answer-1-bis");
  assert.equal(updated.answered.a, "answer-1-bis");
});

test("answered keys prune when their card falls out of the cap", () => {
  // Fill the cap, answer a card, then push it out with newer asks: the
  // answered entry must leave with it, or the map grows forever.
  const first = Array.from({ length: ASKS_CACHE_CAP }, (_, i) =>
    ask(`old-${i}`, i),
  );
  let entry = mergeCachedAsks(empty(), first);
  entry = markCachedAnswered(entry, "old-0", "answer-for-old-0");
  assert.equal(entry.answered["old-0"], "answer-for-old-0");
  const evictor = ask("fresh", ASKS_CACHE_CAP + 10_000);
  entry = mergeCachedAsks(entry, [evictor]);
  assert.ok(!entry.asks.some((a) => a.id === "old-0"));
  assert.equal(entry.answered["old-0"], undefined);
  // An answer whose card is still tracked survives the same merge — and the
  // eviction victim this time is old-1, the new oldest.
  entry = markCachedAnswered(entry, "old-50", "answer-for-old-50");
  entry = mergeCachedAsks(entry, [ask("fresher", ASKS_CACHE_CAP + 20_000)]);
  assert.equal(entry.answered["old-50"], "answer-for-old-50");
  assert.ok(!entry.asks.some((a) => a.id === "old-1"));
});

test("the stored card round-trips through the current parser", () => {
  const item = ask("a", 1);
  const revived = fromCachedAsk(toCachedAsk(item));
  assert.ok(revived, "a valid card must re-parse");
  assert.equal(revived.card.title, card.title);
  assert.equal(revived.card.options[0].recommended, true);
  assert.equal(revived.channelType, "stream");
});

test("fromCachedAsk refuses a payload the current parser rejects", () => {
  // A garbage cardJson degrades to null — the cache never ships a shape the
  // renderer cannot draw.
  assert.equal(
    fromCachedAsk({ ...toCachedAsk(ask("a", 1)), cardJson: "not json" }),
    null,
  );
});

test("unavailable storage cold-starts instead of throwing", async () => {
  // Node has no IndexedDB: idb-keyval's get/set throw under us. The load
  // must RESOLVE null (cold start) and the save must resolve — the cache is
  // an optimization, never fatal.
  assert.equal(await loadAsksCache(), null);
  await saveAsksCache(empty());
});
