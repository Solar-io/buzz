import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BOUNDS,
  EXPORT_PAGE_SIZE,
  describeStopReason,
  exportPageFilter,
  planPage,
} from "./exportPlan.ts";

function ev(id, createdAt, overrides = {}) {
  return {
    id,
    pubkey: "aa".repeat(32),
    created_at: createdAt,
    kind: 9,
    tags: [["h", "chan"]],
    content: `m-${id}`,
    sig: "ff".repeat(64),
    ...overrides,
  };
}

function page(count, startId, createdAt) {
  return Array.from({ length: count }, (_, index) =>
    ev(`${startId + index}`, createdAt - index),
  );
}

const BOUNDS = { maxEvents: 1000, maxPages: 50 };

// ── exportPageFilter ────────────────────────────────────────────────────────

test("first page asks without `until` so the relay serves the newest events", () => {
  const filter = exportPageFilter("chan", [9, 40002], null, 200);
  assert.equal("until" in filter, false, "no until on the newest page");
  assert.deepEqual(filter["#h"], ["chan"]);
  assert.deepEqual(filter.kinds, [9, 40002]);
  assert.equal(filter.limit, 200);
});

test("later pages carry the `until` cursor and sorted kinds", () => {
  const filter = exportPageFilter("chan", [40002, 5, 9], 1_700_000_000, 50);
  assert.equal(filter.until, 1_700_000_000);
  assert.deepEqual(filter.kinds, [5, 9, 40002], "kinds sort ascending");
  assert.equal(filter.limit, 50);
});

test("a negative cursor clamps to zero rather than being sent as-is", () => {
  assert.equal(exportPageFilter("chan", [9], -5).until, 0);
});

test("the default page size is the exported constant", () => {
  assert.equal(exportPageFilter("chan", [9], null).limit, EXPORT_PAGE_SIZE);
  assert.equal(EXPORT_PAGE_SIZE, 200);
});

// ── planPage: cursor advance ────────────────────────────────────────────────

test("a full page steps the cursor one second below its oldest event", () => {
  const events = page(10, 1, 1_000);
  const plan = planPage({
    page: events,
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  assert.equal(plan.done, false);
  // events run 1000 down to 991; the cursor must land at 990, NOT 991,
  // or the oldest event repeats forever on the next page.
  assert.equal(plan.nextUntil, 990);
  assert.equal(plan.accepted.length, 10);
});

test("accepted events come back ascending by created_at", () => {
  const plan = planPage({
    page: page(5, 1, 1_000),
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  const times = plan.accepted.map((event) => event.created_at);
  assert.deepEqual(times, [996, 997, 998, 999, 1000]);
});

test("a cursor that would go below zero ends the walk", () => {
  const plan = planPage({
    page: [ev("a", 0), ev("b", 0), ev("c", 0)],
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 3,
    bounds: BOUNDS,
  });
  assert.equal(plan.done, true);
  assert.equal(plan.reason, "complete");
  assert.equal(plan.nextUntil, null);
});

// ── planPage: termination ───────────────────────────────────────────────────

test("a short page means the relay ran out of history", () => {
  const plan = planPage({
    page: page(3, 1, 500),
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  assert.equal(plan.done, true);
  assert.equal(plan.reason, "complete");
  assert.equal(plan.accepted.length, 3);
});

test("an empty page ends the walk without inventing a cursor", () => {
  const plan = planPage({
    page: [],
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  assert.equal(plan.done, true);
  assert.equal(plan.reason, "complete");
  assert.equal(plan.nextUntil, null);
  assert.equal(plan.accepted.length, 0);
});

test("the page ceiling stops a walk that would otherwise continue", () => {
  // A FULL page, so the only reason to stop is the page ceiling.
  const plan = planPage({
    page: page(10, 1, 1_000),
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 2,
    pageSize: 10,
    bounds: { maxEvents: 1000, maxPages: 3 },
  });
  assert.equal(plan.done, true);
  assert.equal(plan.reason, "max-pages");
});

test("one page below the ceiling keeps going", () => {
  const plan = planPage({
    page: page(10, 1, 1_000),
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 1,
    pageSize: 10,
    bounds: { maxEvents: 1000, maxPages: 3 },
  });
  assert.equal(plan.done, false, "pageIndex 1 of maxPages 3 is not the last");
  assert.equal(plan.reason, null);
});

// ── planPage: the event ceiling keeps the NEWEST events ─────────────────────

test("the event ceiling truncates the oldest events, not the newest", () => {
  const plan = planPage({
    page: page(10, 1, 1_000),
    seen: new Set(),
    totalAccepted: 6,
    pageIndex: 0,
    pageSize: 10,
    bounds: { maxEvents: 10, maxPages: 50 },
  });
  assert.equal(plan.done, true);
  assert.equal(plan.reason, "max-events");
  assert.equal(plan.accepted.length, 4, "only the remaining budget is kept");
  const times = plan.accepted.map((event) => event.created_at);
  // The page spans 991..1000. Keeping the newest four means 997..1000.
  assert.deepEqual(times, [997, 998, 999, 1000]);
});

test("an exhausted budget accepts nothing and stops", () => {
  const plan = planPage({
    page: page(10, 1, 1_000),
    seen: new Set(),
    totalAccepted: 10,
    pageIndex: 0,
    pageSize: 10,
    bounds: { maxEvents: 10, maxPages: 50 },
  });
  assert.equal(plan.accepted.length, 0);
  assert.equal(plan.reason, "max-events");
});

// ── planPage: dedup ─────────────────────────────────────────────────────────

test("events already accepted by an earlier page are dropped", () => {
  const events = page(4, 1, 1_000);
  const plan = planPage({
    page: events,
    seen: new Set(["1", "2"]),
    totalAccepted: 2,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  assert.deepEqual(
    plan.accepted.map((event) => event.id),
    ["4", "3"],
    "ascending by created_at: id 4 is older than id 3",
  );
});

test("a relay that repeats an event inside one page yields it once", () => {
  const duplicate = ev("dupe", 900);
  const plan = planPage({
    page: [duplicate, { ...duplicate }, ev("other", 899)],
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  assert.deepEqual(
    plan.accepted.map((event) => event.id),
    ["other", "dupe"],
  );
});

test("planPage does not mutate the caller's seen set", () => {
  const seen = new Set(["1"]);
  planPage({
    page: page(4, 1, 1_000),
    seen,
    totalAccepted: 1,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  assert.deepEqual([...seen], ["1"], "seen is read-only to the planner");
});

// ── planPage: timestamp saturation ──────────────────────────────────────────

test("a full page all at one second is flagged as unreachable-past", () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    ev(`s${index}`, 1_234),
  );
  const plan = planPage({
    page: events,
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 5,
    bounds: BOUNDS,
  });
  assert.equal(plan.sameTimestampPage, true);
  assert.equal(plan.nextUntil, 1_233, "cursor still makes progress");
});

test("a page spanning more than one second is not flagged", () => {
  const plan = planPage({
    page: [ev("a", 1_234), ev("b", 1_234), ev("c", 1_233)],
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 3,
    bounds: BOUNDS,
  });
  assert.equal(plan.sameTimestampPage, false);
});

test("a SHORT page all at one second is not flagged — nothing was cut off", () => {
  const plan = planPage({
    page: [ev("a", 1_234), ev("b", 1_234)],
    seen: new Set(),
    totalAccepted: 0,
    pageIndex: 0,
    pageSize: 10,
    bounds: BOUNDS,
  });
  assert.equal(plan.sameTimestampPage, false);
});

// ── describeStopReason ──────────────────────────────────────────────────────

test("only a complete walk describes itself as complete", () => {
  assert.match(describeStopReason("complete", DEFAULT_BOUNDS), /^Complete/);
  for (const reason of ["max-events", "max-pages", "cancelled"]) {
    assert.doesNotMatch(
      describeStopReason(reason, DEFAULT_BOUNDS),
      /^Complete/,
      `${reason} must not read as complete`,
    );
  }
});

test("the ceiling messages name the ceiling that actually bit", () => {
  const bounds = { maxEvents: 7, maxPages: 3 };
  assert.match(describeStopReason("max-events", bounds), /7-event/);
  assert.match(describeStopReason("max-pages", bounds), /3-page/);
});
