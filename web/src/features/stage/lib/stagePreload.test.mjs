import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeckPreloader, preloadDeck } from "./stagePreload.ts";

async function flush() {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
}

function fetcher() {
  const started = [];
  const pending = new Map();
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    started,
    maxInFlight: () => maxInFlight,
    fetch(url) {
      started.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve, reject) => {
        pending.set(url, {
          ok: () => {
            inFlight -= 1;
            resolve(`blob:${url}`);
          },
          fail: () => {
            inFlight -= 1;
            reject(new Error("boom"));
          },
        });
      });
    },
    async ok(url) {
      pending.get(url).ok();
      await flush();
    },
    async fail(url) {
      pending.get(url).fail();
      await flush();
    },
  };
}

const URLS = ["u0", "u1", "u2", "u3", "u4", "u5"];

test("at most 3 fetches in flight", async () => {
  const f = fetcher();
  preloadDeck(URLS, { fetch: f.fetch });
  assert.deepEqual(f.started, ["u0", "u1", "u2"]);
  await f.ok("u0");
  assert.deepEqual(f.started, ["u0", "u1", "u2", "u3"]);
  for (const url of ["u1", "u2", "u3", "u4"]) await f.ok(url);
  assert.equal(f.started.length, 6);
  assert.equal(f.maxInFlight(), 3);
});

test("the frame after the current one is fetched first", async () => {
  const f = fetcher();
  preloadDeck(URLS, { fetch: f.fetch, first: 3 });
  assert.equal(f.started[0], "u3");
  assert.deepEqual(f.started, ["u3", "u4", "u5"]);
});

test("prioritize jumps the queue", async () => {
  const f = fetcher();
  const preloader = preloadDeck(URLS, { fetch: f.fetch });
  preloader.prioritize("u5");
  await f.ok("u0");
  assert.equal(f.started[3], "u5");
});

test("one rejection does not stop the rest; it resolves null", async () => {
  const f = fetcher();
  const preloader = preloadDeck(URLS.slice(0, 4), { fetch: f.fetch });
  const failed = preloader.whenReady("u1");
  await f.fail("u1");
  assert.equal(await failed, null);
  assert.deepEqual(f.started, ["u0", "u1", "u2", "u3"]);
  await f.ok("u3");
  assert.equal(await preloader.whenReady("u3"), "blob:u3");
  assert.equal(preloader.peek("u3"), "blob:u3");
});

test("duplicate URLs are fetched once", async () => {
  const f = fetcher();
  const preloader = createDeckPreloader({ fetch: f.fetch });
  preloader.enqueue(["a", "a", "b"]);
  preloader.enqueue(["a", "b"]);
  preloader.prioritize("a");
  preloader.whenReady("b");
  assert.deepEqual(f.started, ["a", "b"]);
});

test("decode runs on the fetched object URL before ready", async () => {
  const f = fetcher();
  const decoded = [];
  const preloader = createDeckPreloader({
    fetch: f.fetch,
    decode: async (objectUrl) => decoded.push(objectUrl),
  });
  preloader.enqueue(["a"]);
  const ready = preloader.whenReady("a");
  await f.ok("a");
  assert.equal(await ready, "blob:a");
  assert.deepEqual(decoded, ["blob:a"]);
});
