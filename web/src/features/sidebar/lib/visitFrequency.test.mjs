import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadVisitScores,
  recordVisit,
  saveVisitScores,
  visitScore,
} from "./visitFrequency.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

test("an unvisited item scores 0; one visit scores 1 at that instant", () => {
  const scores = recordVisit({}, "a", T0);
  assert.equal(visitScore(scores, "missing", T0), 0);
  assert.equal(visitScore(scores, "a", T0), 1);
});

test("a visit's weight halves after 7 days and quarters after 14", () => {
  const scores = recordVisit({}, "a", T0);
  assert.ok(Math.abs(visitScore(scores, "a", T0 + 7 * DAY) - 0.5) < 1e-9);
  assert.ok(Math.abs(visitScore(scores, "a", T0 + 14 * DAY) - 0.25) < 1e-9);
});

test("visits accumulate on top of the decayed score", () => {
  let scores = recordVisit({}, "a", T0);
  scores = recordVisit(scores, "a", T0 + 7 * DAY);
  // 1 decayed to 0.5, plus the new visit.
  assert.ok(Math.abs(visitScore(scores, "a", T0 + 7 * DAY) - 1.5) < 1e-9);
});

test("recent habit beats an old burst: 2 visits today > 5 visits a month ago", () => {
  let scores = {};
  for (let i = 0; i < 5; i += 1) scores = recordVisit(scores, "old", T0);
  const now = T0 + 30 * DAY;
  scores = recordVisit(scores, "new", now);
  scores = recordVisit(scores, "new", now);
  assert.ok(visitScore(scores, "new", now) > visitScore(scores, "old", now));
});

test("recordVisit never mutates its input", () => {
  const before = recordVisit({}, "a", T0);
  const snapshot = JSON.stringify(before);
  recordVisit(before, "a", T0 + DAY);
  recordVisit(before, "b", T0 + DAY);
  assert.equal(JSON.stringify(before), snapshot);
});

test("past 400 entries the weakest are dropped, the fresh visit kept", () => {
  let scores = {};
  for (let i = 0; i < 400; i += 1) scores = recordVisit(scores, `k${i}`, T0);
  scores = recordVisit(scores, "k0", T0 + DAY); // k0 is now the strongest
  scores = recordVisit(scores, "fresh", T0 + 2 * DAY);
  assert.equal(Object.keys(scores).length, 400);
  assert.ok("fresh" in scores);
  assert.ok("k0" in scores);
});

test("load/save round-trips and drops malformed entries", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  saveVisitScores(recordVisit({}, "a", T0), storage);
  assert.deepEqual(loadVisitScores(storage), { a: { score: 1, at: T0 } });
  store.set(
    "buzz.sidebar-visits.v1",
    JSON.stringify({
      ok: { score: 2, at: T0 },
      bad: { score: "x" },
      neg: { score: -1, at: 0 },
    }),
  );
  assert.deepEqual(loadVisitScores(storage), { ok: { score: 2, at: T0 } });
  store.set("buzz.sidebar-visits.v1", "{not json");
  assert.deepEqual(loadVisitScores(storage), {});
});
