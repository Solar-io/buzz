import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASKS_CACHE_CAP,
  asksCacheKey,
  emptyAsksCacheEntry,
  fromCachedAsk,
  markCachedAnswered,
  mergeCachedAsks,
  nextPersistedEntry,
  recordCachedProgress,
  sameEntry,
  toCachedAsk,
} from "./askCache.ts";
import { loadAsksCache, saveAsksCache } from "./askCache.ts";

// A parsed card, in the normalized decision-cards-v2 shape the cache stores
// and re-parses (`serializeCardPayload` / `parseCardTags`).
const card = {
  v: 1,
  title: "Ship the fix?",
  questions: [
    {
      id: "0",
      question: "Ship the fix?",
      multiSelect: false,
      options: [
        { id: "0", label: "Yes", recommended: true },
        { id: "1", label: "No" },
      ],
    },
  ],
};

const interview = {
  v: 2,
  title: "Ship the fix",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which surfaces?",
      multiSelect: true,
      options: [
        { id: "web", label: "Web", description: "The SPA", recommended: true },
        { id: "cli", label: "CLI" },
      ],
    },
    {
      id: "1",
      question: "When?",
      options: [
        { id: "0", label: "Now" },
        { id: "1", label: "Later" },
      ],
      multiSelect: false,
    },
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

const empty = () => emptyAsksCacheEntry();

test("the cache key is versioned — a shape change starts fresh, not corrupt", () => {
  assert.equal(asksCacheKey(), "asks:v2");
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

test("emptyAsksCacheEntry carries every field a fold needs", () => {
  // Harness self-check: the folds below spread this, so a missing key would
  // make them silently write `undefined` into the cache.
  assert.deepEqual(emptyAsksCacheEntry(), {
    asks: [],
    answered: {},
    progress: {},
    cursor: 0,
  });
});

test("progress records a partial WITHOUT answering the card", () => {
  // The two maps are deliberately separate: `answered` clears the badge and
  // `progress` only feeds the N/M chip. A partial must land in exactly one
  // of them, and the discriminating assertion is that `answered` is empty.
  let entry = mergeCachedAsks(empty(), [ask("a", 1)]);
  entry = recordCachedProgress(entry, "a", { answered: 2, total: 4, at: 100 });
  assert.deepEqual(entry.progress.a, { answered: 2, total: 4, at: 100 });
  assert.deepEqual(entry.answered, {});

  // Completing it afterwards answers the card; progress is untouched.
  entry = markCachedAnswered(entry, "a", "answer-1");
  assert.equal(entry.answered.a, "answer-1");
  assert.deepEqual(entry.progress.a, { answered: 2, total: 4, at: 100 });
});

test("progress takes the NEWEST answer and re-folds to the same reference", () => {
  // Answer events arrive over four REQ families in no particular order, so
  // an older replay must not overwrite a newer partial.
  let entry = mergeCachedAsks(empty(), [ask("a", 1)]);
  entry = recordCachedProgress(entry, "a", { answered: 3, total: 4, at: 200 });
  const older = recordCachedProgress(entry, "a", {
    answered: 1,
    total: 4,
    at: 100,
  });
  assert.equal(older, entry, "an older event is a no-op, same reference");
  assert.equal(entry.progress.a.answered, 3);

  const replay = recordCachedProgress(entry, "a", {
    answered: 3,
    total: 4,
    at: 200,
  });
  assert.equal(replay, entry, "a replayed identical event is a no-op");

  const newer = recordCachedProgress(entry, "a", {
    answered: 4,
    total: 4,
    at: 300,
  });
  assert.notEqual(newer, entry);
  assert.equal(newer.progress.a.answered, 4);
});

test("a progress-only change is written to disk", () => {
  // The 2026-09-17 badge-resurrect defect, one field over: the persist step
  // decides by CONTENT through sameEntry, so a field sameEntry does not
  // compare never reaches disk. Two entries differing only in progress must
  // not be "same".
  const base = mergeCachedAsks(empty(), [ask("a", 1)]);
  const withProgress = recordCachedProgress(base, "a", {
    answered: 1,
    total: 3,
    at: 5,
  });
  assert.equal(sameEntry(base, withProgress), false);
  const decision = nextPersistedEntry(withProgress, base, []);
  assert.equal(decision.persist, true);
  assert.equal(decision.entry.progress.a.answered, 1);
});

test("progress prunes with the cap, exactly like answered", () => {
  const first = Array.from({ length: ASKS_CACHE_CAP }, (_, i) =>
    ask(`old-${i}`, i),
  );
  let entry = mergeCachedAsks(empty(), first);
  entry = recordCachedProgress(entry, "old-0", {
    answered: 1,
    total: 2,
    at: 1,
  });
  entry = recordCachedProgress(entry, "old-50", {
    answered: 1,
    total: 2,
    at: 1,
  });
  entry = mergeCachedAsks(entry, [ask("fresh", ASKS_CACHE_CAP + 10_000)]);
  assert.equal(
    entry.progress["old-0"],
    undefined,
    "evicted card's progress goes",
  );
  assert.deepEqual(entry.progress["old-50"], { answered: 1, total: 2, at: 1 });
});

test("the stored card round-trips through the current parser", () => {
  const item = ask("a", 1);
  const revived = fromCachedAsk(toCachedAsk(item));
  assert.ok(revived, "a valid card must re-parse");
  assert.equal(revived.card.title, card.title);
  assert.equal(revived.card.questions[0].options[0].recommended, true);
  assert.deepEqual(revived.card, card);
  assert.equal(revived.channelType, "stream");
});

test("a v2 interview round-trips through the cache unchanged", () => {
  // The stored payload is written by `serializeCardPayload`, not by
  // re-tagging the parsed card — the old `{v:1, ...card}` re-tag produced a
  // payload the current parser rejects, which would have silently dropped
  // every multi-question ask from the badge on reload.
  const item = ask("a", 1, { card: interview });
  const revived = fromCachedAsk(toCachedAsk(item));
  assert.ok(revived, "a v2 card must re-parse");
  assert.deepEqual(revived.card, interview);
  assert.equal(revived.card.questions.length, 2);
  assert.equal(revived.card.questions[0].multiSelect, true);
  assert.equal(revived.card.questions[0].options[0].description, "The SPA");
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

test("nextPersistedEntry: an answered-only fold is written to disk", () => {
  // The reload-resurrect regression: the ask set is settled on disk, then a
  // live answer folds into provider state. The merged candidate carries the
  // fold in the very `answered` ref it would be compared against — only a
  // CONTENT comparison against the last SAVED entry can see it.
  const disk = mergeCachedAsks(empty(), [ask("a", 100)]);
  const folded = markCachedAnswered(disk, "a", "answer-for-a");
  const decision = nextPersistedEntry(folded, disk, [ask("a", 100)]);
  assert.ok(decision, "a decision must come back");
  assert.equal(decision.persist, true, "the fold must reach disk");
  assert.equal(
    decision.stateChanges,
    false,
    "provider state already holds the fold",
  );
});

test("nextPersistedEntry: unchanged content writes nothing", () => {
  const disk = mergeCachedAsks(empty(), [ask("a", 100)]);
  const decision = nextPersistedEntry(disk, disk, [ask("a", 100)]);
  assert.equal(decision.persist, false);
  assert.equal(decision.stateChanges, false);
});

test("nextPersistedEntry: a new ask both writes and updates state", () => {
  const disk = mergeCachedAsks(empty(), [ask("a", 100)]);
  const decision = nextPersistedEntry(disk, disk, [
    ask("a", 100),
    ask("b", 200),
  ]);
  assert.equal(decision.persist, true);
  assert.equal(decision.stateChanges, true);
  assert.deepEqual(
    decision.entry.asks.map((a) => a.id),
    ["b", "a"],
  );
});

test("nextPersistedEntry: first-ever write (no saved entry) persists", () => {
  const current = mergeCachedAsks(empty(), [ask("a", 1)]);
  const decision = nextPersistedEntry(current, null, [ask("a", 1)]);
  assert.equal(decision.persist, true);
});

test("nextPersistedEntry: null current state decides nothing", () => {
  assert.equal(nextPersistedEntry(null, null, []), null);
});
