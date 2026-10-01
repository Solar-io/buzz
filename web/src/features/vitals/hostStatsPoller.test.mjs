import assert from "node:assert/strict";
import { test } from "node:test";

import { createHostStatsPoller } from "./hostStatsPoller.ts";

/**
 * W-3 (cadence half), against the shipping poller: one fetch on subscribe,
 * then every 10 s; nothing at all while the tab is hidden; a failed poll
 * clears the numbers instead of leaving them up as if current.
 */

function rig({ hidden = false, results = [] } = {}) {
  const intervals = new Map();
  let nextId = 1;
  let isHidden = hidden;
  let visibilityListener = null;
  let fetches = 0;
  const queue = [...results];
  const poller = createHostStatsPoller({
    fetch: async () => {
      fetches += 1;
      return queue.shift() ?? { kind: "ok", data: sample(fetches) };
    },
    isHidden: () => isHidden,
    onVisibilityChange: (listener) => {
      visibilityListener = listener;
      return () => {
        visibilityListener = null;
      };
    },
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  });
  return {
    poller,
    get fetches() {
      return fetches;
    },
    intervals,
    tick: () => {
      for (const { fn } of intervals.values()) fn();
    },
    setHidden(value) {
      isHidden = value;
      visibilityListener?.();
    },
  };
}

function sample(n) {
  return {
    host: "crichton",
    sampledAt: new Date().toISOString(),
    uptimeSec: 1,
    load: null,
    cpu: n * 10,
    gpu: { percent: n, renderer: null, tiler: null },
    mem: null,
    disks: [],
    primaryDisk: null,
    services: null,
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test("subscribe fetches at once, then every 10 s on ONE interval", async () => {
  const r = rig();
  const stop = r.poller.subscribe(() => {});
  r.poller.subscribe(() => {});
  assert.equal(r.fetches, 1);
  assert.deepEqual(
    [...r.intervals.values()].map((i) => i.ms),
    [10_000],
  );
  await settle();
  r.tick();
  await settle();
  assert.equal(r.fetches, 2);
  assert.equal(r.poller.getSnapshot().stats.cpu, 20);
  assert.deepEqual(
    r.poller.getSnapshot().history.map((h) => h.cpu),
    [10, 20],
  );
  stop();
});

test("hidden: no interval and no request; visible again: refresh at once", async () => {
  const r = rig({ hidden: true });
  r.poller.subscribe(() => {});
  assert.equal(r.fetches, 0);
  assert.equal(r.intervals.size, 0);
  r.setHidden(false);
  assert.equal(r.fetches, 1);
  assert.equal(r.intervals.size, 1);
  r.setHidden(true);
  assert.equal(r.intervals.size, 0, "the interval stops while hidden");
  r.tick();
  assert.equal(r.fetches, 1);
});

test("a failed poll clears the numbers (offline), it never keeps the old ones", async () => {
  const r = rig({
    results: [{ kind: "ok", data: sample(1) }, { kind: "unreachable" }],
  });
  r.poller.subscribe(() => {});
  await settle();
  assert.equal(r.poller.getSnapshot().status, "ok");
  r.tick();
  await settle();
  assert.equal(r.poller.getSnapshot().status, "offline");
  assert.equal(r.poller.getSnapshot().stats, null);
});

test("the last unsubscribe stops polling", async () => {
  const r = rig();
  const stop = r.poller.subscribe(() => {});
  stop();
  assert.equal(r.intervals.size, 0);
});
