import assert from "node:assert/strict";
import { test } from "node:test";

import { createStageFeed } from "./stageFeed.ts";
import { createStagePacer } from "./stagePacing.ts";

const NOW = 1_800_000_000;

function realPacer() {
  const spoken = [];
  const pacer = createStagePacer({
    clock: {
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    voice: true,
    speak: (showing) => {
      spoken.push(showing.eventId);
      return new Promise(() => {});
    },
    interrupt: () => {},
  });
  return { pacer, spoken };
}

const s = (id, createdAt, extra = {}) => ({
  eventId: id,
  hold: true,
  speakText: `Words for ${id}.`,
  createdAt,
  ...extra,
});

async function flush() {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
}

test("bug6: a showing arriving live while history loads is queued and spoken, not seeded as shown", async () => {
  const { pacer, spoken } = realPacer();
  const feed = createStageFeed(pacer, { mode: "late", nowSec: NOW });
  const old = s("h1", NOW - 600);
  // First look: the buffer already has one old showing; history not loaded.
  feed.update([old], false);
  // The agent posts while history is loading.
  const live = s("l1", NOW + 2);
  feed.update([old, live], false);
  // History settles (brings another old showing).
  const older = s("h0", NOW - 900);
  feed.update([older, old, live], true);
  await flush();
  const state = pacer.state();
  assert.equal(state.current?.eventId, "l1", "the live showing is staged");
  assert.deepEqual(spoken, ["l1"], "and spoken; history is not");
  assert.equal(state.showings.length, 3);
});

test("bug6: pure history (nothing new before load) still late-joins silently", async () => {
  const { pacer, spoken } = realPacer();
  const feed = createStageFeed(pacer, { mode: "late", nowSec: NOW });
  feed.update([s("h1", NOW - 600)], false);
  feed.update([s("h0", NOW - 900), s("h1", NOW - 600)], true);
  await flush();
  assert.equal(pacer.state().current?.eventId, "h1");
  assert.deepEqual(spoken, []);
});

test("bug6: an OLD row back-filled into the buffer before history is history, not live", async () => {
  const { pacer, spoken } = realPacer();
  const feed = createStageFeed(pacer, { mode: "late", nowSec: NOW });
  feed.update([], false);
  feed.update([s("h0", NOW - 3_600)], false);
  feed.update([s("h0", NOW - 3_600)], true);
  await flush();
  assert.deepEqual(spoken, []);
  assert.equal(pacer.state().current?.eventId, "h0");
});

test("bug6: after seeding, updates feed arrive()", async () => {
  const { pacer, spoken } = realPacer();
  const feed = createStageFeed(pacer, { mode: "late", nowSec: NOW });
  feed.update([s("h1", NOW - 600)], true);
  feed.update([s("h1", NOW - 600), s("l2", NOW + 5)], true);
  await flush();
  assert.equal(pacer.state().current?.eventId, "l2");
  assert.deepEqual(spoken, ["l2"]);
});
