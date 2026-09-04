import assert from "node:assert/strict";
import { test } from "node:test";
import { exportChannelEvents } from "./exportChannel.ts";

const SESSION = { subscribe: () => () => {} };
const NO_BREATHE = () => Promise.resolve();

function ev(id, createdAt) {
  return {
    id,
    pubkey: "aa".repeat(32),
    created_at: createdAt,
    kind: 9,
    tags: [["h", "chan"]],
    content: `m-${id}`,
    sig: "ff".repeat(64),
  };
}

/**
 * A relay holding `total` events, one per second counting down from `newest`.
 * Answers `until`/`limit` the way NIP-01 says: newest-first, `until` inclusive.
 */
function fakeRelay(total, newest = 10_000) {
  const all = Array.from({ length: total }, (_, index) =>
    ev(`e${index}`, newest - index),
  );
  const filters = [];
  const query = async (_session, filter) => {
    filters.push(filter);
    const window =
      filter.until === undefined
        ? all
        : all.filter((event) => event.created_at <= filter.until);
    return window.slice(0, filter.limit);
  };
  return { all, filters, query };
}

test("a single short page finishes in one round-trip", async () => {
  const relay = fakeRelay(3);
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 10,
    queryPage: relay.query,
    breathe: NO_BREATHE,
  });
  assert.equal(run.pages, 1);
  assert.equal(run.reason, "complete");
  assert.equal(run.events.length, 3);
});

test("a multi-page history is walked to the end with no gaps and no repeats", async () => {
  const relay = fakeRelay(250);
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 100,
    queryPage: relay.query,
    breathe: NO_BREATHE,
  });
  assert.equal(run.reason, "complete");
  assert.equal(run.events.length, 250, "every event is exported exactly once");
  assert.equal(
    new Set(run.events.map((event) => event.id)).size,
    250,
    "no duplicates",
  );
  assert.equal(run.pages, 3, "100 + 100 + 50");
  // Ascending, contiguous seconds — a dropped page would leave a hole.
  const times = run.events.map((event) => event.created_at);
  assert.equal(times[0], 10_000 - 249);
  assert.equal(times[times.length - 1], 10_000);
  for (let i = 1; i < times.length; i += 1) {
    assert.equal(times[i], times[i - 1] + 1, `gap before index ${i}`);
  }
});

test("the first REQ omits `until` and every later one carries it", async () => {
  const relay = fakeRelay(250);
  await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9, 5],
    pageSize: 100,
    queryPage: relay.query,
    breathe: NO_BREATHE,
  });
  assert.equal(relay.filters.length, 3);
  assert.equal(relay.filters[0].until, undefined);
  assert.equal(relay.filters[1].until, 10_000 - 99 - 1);
  assert.equal(relay.filters[2].until, 10_000 - 199 - 1);
  for (const filter of relay.filters) {
    assert.deepEqual(filter["#h"], ["chan"]);
    assert.deepEqual(filter.kinds, [5, 9]);
  }
});

test("the event ceiling truncates and reports max-events", async () => {
  const relay = fakeRelay(250);
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 100,
    bounds: { maxEvents: 150, maxPages: 400 },
    queryPage: relay.query,
    breathe: NO_BREATHE,
  });
  assert.equal(run.reason, "max-events");
  assert.equal(run.events.length, 150);
  // The newest 150 were kept, so the newest event is still present.
  assert.equal(run.events[run.events.length - 1].created_at, 10_000);
  assert.equal(run.events[0].created_at, 10_000 - 149);
});

test("the page ceiling stops the walk and reports max-pages", async () => {
  const relay = fakeRelay(1_000);
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 100,
    bounds: { maxEvents: 100_000, maxPages: 2 },
    queryPage: relay.query,
    breathe: NO_BREATHE,
  });
  assert.equal(run.reason, "max-pages");
  assert.equal(run.pages, 2);
  assert.equal(run.events.length, 200);
});

test("progress is reported once per page and counts up", async () => {
  const relay = fakeRelay(250);
  const seen = [];
  await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 100,
    queryPage: relay.query,
    breathe: NO_BREATHE,
    onProgress: (progress) => seen.push({ ...progress }),
  });
  assert.equal(seen.length, 3, "one progress tick per page");
  assert.deepEqual(
    seen.map((p) => p.events),
    [100, 200, 250],
  );
  assert.deepEqual(
    seen.map((p) => p.pages),
    [1, 2, 3],
  );
  assert.equal(seen[2].oldestCreatedAt, 10_000 - 249);
});

test("aborting between pages returns what was collected, marked cancelled", async () => {
  const relay = fakeRelay(1_000);
  const controller = new AbortController();
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 100,
    signal: controller.signal,
    queryPage: relay.query,
    breathe: NO_BREATHE,
    onProgress: (progress) => {
      if (progress.pages === 2) {
        controller.abort();
      }
    },
  });
  assert.equal(run.reason, "cancelled");
  assert.equal(run.pages, 2);
  assert.equal(run.events.length, 200);
});

test("an already-aborted signal makes no relay request at all", async () => {
  const relay = fakeRelay(100);
  const controller = new AbortController();
  controller.abort();
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 10,
    signal: controller.signal,
    queryPage: relay.query,
    breathe: NO_BREATHE,
  });
  assert.equal(relay.filters.length, 0);
  assert.equal(run.reason, "cancelled");
  assert.equal(run.events.length, 0);
});

test("no selected kinds means no relay traffic and an empty archive", async () => {
  const relay = fakeRelay(100);
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [],
    queryPage: relay.query,
    breathe: NO_BREATHE,
  });
  assert.equal(relay.filters.length, 0);
  assert.equal(run.events.length, 0);
  assert.equal(run.pages, 0);
});

test("a relay that re-serves the boundary event does not duplicate it", async () => {
  // `until` treated as EXCLUSIVE by the fake would drop an event; treated as
  // sloppy (returning one already seen) must not double it either.
  const all = [ev("a", 300), ev("b", 200), ev("c", 200), ev("d", 100)];
  let call = 0;
  const query = async () => {
    call += 1;
    return call === 1 ? all.slice(0, 2) : call === 2 ? [all[1], all[2]] : [];
  };
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 2,
    queryPage: query,
    breathe: NO_BREATHE,
  });
  // b and c share created_at 200, so id breaks the tie; a is newest.
  assert.deepEqual(
    run.events.map((event) => event.id),
    ["b", "c", "a"],
    "b is served twice and kept once",
  );
});

test("a full page all at one second is counted as a saturated page", async () => {
  const page = [ev("x", 500), ev("y", 500)];
  let call = 0;
  const query = async () => {
    call += 1;
    return call === 1 ? page : [];
  };
  const run = await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 2,
    queryPage: query,
    breathe: NO_BREATHE,
  });
  assert.equal(run.sameTimestampPages, 1);
});

test("the walk yields to the event loop between pages", async () => {
  const relay = fakeRelay(250);
  let breaths = 0;
  await exportChannelEvents({
    session: SESSION,
    channelId: "chan",
    kinds: [9],
    pageSize: 100,
    queryPage: relay.query,
    breathe: () => {
      breaths += 1;
      return Promise.resolve();
    },
  });
  // Three pages, two gaps between them — never after the last page.
  assert.equal(breaths, 2);
});
