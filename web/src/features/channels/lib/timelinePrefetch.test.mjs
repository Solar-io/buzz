import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPrefetchBudget,
  prefetchTimeline,
  selectPrefetchCandidates,
} from "./timelinePrefetch.ts";

/** A peek-only store over a plain object of {id: {cursor}} entries. */
function peekStore(entries = {}) {
  return { peek: (id) => entries[id] ?? null };
}

test("T11 candidates: the top 6 by MERGED recency (channels + DMs), newest first", () => {
  const samples = [
    { id: "c1", at: 100 },
    { id: "dm1", at: 900 },
    { id: "c2", at: 800 },
    { id: "dm2", at: 50 },
    { id: "c3", at: 700 },
    { id: "c4", at: 600 },
    { id: "dm3", at: 500 },
    { id: "c5", at: 400 },
    { id: "c6", at: 0 }, // never active: never a candidate
  ];
  assert.deepEqual(selectPrefetchCandidates(samples, peekStore(), null), [
    "dm1",
    "c2",
    "c3",
    "c4",
    "dm3",
    "c5",
  ]);
});

test("T11 candidates: skips entries already synced through their activity, and the open one", () => {
  const samples = [
    { id: "fresh", at: 500 },
    { id: "stale", at: 500 },
    { id: "warmOnly", at: 500 },
    { id: "open", at: 900 },
  ];
  const store = peekStore({
    fresh: { cursor: 500, messages: [] },
    stale: { cursor: 400, messages: [] },
    // A warm write put the row in but did not move the cursor: not fresh.
    warmOnly: { cursor: 0, messages: [{ createdAt: 500 }] },
  });
  assert.deepEqual(selectPrefetchCandidates(samples, store, "open"), [
    "stale",
    "warmOnly",
  ]);
});

test("T11 candidates: a skipped fresh entry does not pull in a 7th", () => {
  const samples = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    at: 1000 - i,
  }));
  const store = peekStore({ c0: { cursor: 1000, messages: [] } });
  assert.deepEqual(selectPrefetchCandidates(samples, store, null), [
    "c1",
    "c2",
    "c3",
    "c4",
    "c5",
  ]);
});

test("T11 budget: at most 12 per rolling minute (fake clock)", () => {
  let now = 0;
  const budget = createPrefetchBudget(() => now);
  let granted = 0;
  for (let i = 0; i < 20; i++) {
    if (budget.take()) granted++;
  }
  assert.equal(granted, 12);
  now = 59_999;
  assert.equal(budget.take(), false, "still inside the minute");
  now = 60_000;
  assert.equal(budget.take(), true, "the first spend has aged out");
  assert.equal(budget.take(), true);
});

test("prefetchTimeline: one delta REQ since the cursor at background priority, sync-mode applies, closed on EOSE", async () => {
  const applied = [];
  const store = {
    isOwned: () => false,
    load: async () => ({ cursor: 1234, messages: [] }),
    apply: (id, event, options) => applied.push([id, event.id, options.source]),
  };
  const subs = [];
  const session = {
    subscribe(filters, options) {
      const sub = { filters, options, closed: false };
      subs.push(sub);
      return () => {
        sub.closed = true;
      };
    },
  };
  await prefetchTimeline(store, session, "chan");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].options.priority, "background");
  assert.equal(subs[0].filters[0].since, 1234);
  subs[0].options.onEvent({ id: "e1", kind: 9, tags: [["h", "chan"]] });
  assert.deepEqual(applied, [["chan", "e1", "prefetch"]]);
  // In flight: a second prefetch of the same channel is a no-op.
  await prefetchTimeline(store, session, "chan");
  assert.equal(subs.length, 1);
  subs[0].options.onEose();
  assert.equal(subs[0].closed, true);
});

test("prefetchTimeline skips the owned (open) channel", async () => {
  let subscribed = 0;
  await prefetchTimeline(
    { isOwned: () => true, load: async () => ({ cursor: 1, messages: [] }) },
    { subscribe: () => (subscribed++, () => {}) },
    "open",
  );
  assert.equal(subscribed, 0);
});
