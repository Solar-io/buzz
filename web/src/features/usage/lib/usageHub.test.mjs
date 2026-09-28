/**
 * usageHub: strict-but-forgiving parse of usage-hub `/v1/pace`, and a fetch
 * that never throws and never invents data.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { fetchPace, PACE_URL, parsePace } from "./usageHub.ts";

// Shaped like the live 2026-09-28 data: A known at 92%, B stale.
const LIVE_SHAPED = {
  v: 1,
  computedAt: "2026-09-28T18:48:00Z",
  status: "ok",
  nextReset: { account: "A", resetsAt: "2026-09-29T13:00:00Z" },
  headroomAccounts: 0.08,
  headroomPartial: true,
  accounts: [
    {
      id: "A",
      isDefault: true,
      state: "known",
      usedFraction: 0.92,
      resetsAt: "2026-09-29T13:00:00Z",
      elapsedFraction: 0.892,
      projectedAtReset: 0.935,
      etaFullAt: null,
      basis: "trailing-24h",
      status: "ok",
    },
    {
      id: "B",
      isDefault: false,
      state: "stale",
      usedFraction: null,
      resetsAt: "2026-10-01T20:00:00Z",
      elapsedFraction: null,
      projectedAtReset: null,
      etaFullAt: null,
      basis: null,
      status: "unknown",
    },
    { id: "", state: "bogus" },
  ],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("parsePace keeps both valid accounts and leaves unknown usage null", () => {
  const pace = parsePace(LIVE_SHAPED);
  assert.ok(pace);
  assert.equal(pace.accounts.length, 2);
  assert.equal(pace.accounts[0].usedFraction, 0.92);
  assert.equal(pace.accounts[1].usedFraction, null);
  assert.equal(pace.headroomAccounts, 0.08);
  assert.deepEqual(pace.nextReset, {
    account: "A",
    resetsAt: "2026-09-29T13:00:00Z",
  });
});

test("parsePace rejects a non-v1 payload", () => {
  assert.equal(parsePace({ ...LIVE_SHAPED, v: 2 }), null);
  assert.equal(parsePace(null), null);
});

test("fetchPace resolves null on a 403 (not an empty object)", async () => {
  let calledWith = null;
  globalThis.fetch = async (url, init) => {
    calledWith = { url, init };
    return new Response("forbidden", { status: 403 });
  };
  assert.equal(await fetchPace(), null);
  assert.equal(calledWith.url, PACE_URL);
  assert.equal(calledWith.init.headers, undefined);
});

test("fetchPace resolves null when fetch rejects (CORS/network)", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await fetchPace(), null);
});

test("fetchPace parses an ok response", async () => {
  globalThis.fetch = async () => Response.json(LIVE_SHAPED);
  const pace = await fetchPace();
  assert.equal(pace?.accounts.length, 2);
});
