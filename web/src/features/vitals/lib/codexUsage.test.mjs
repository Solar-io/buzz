import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_URL, fetchCodex } from "../useVitals.ts";
import {
  codexCost,
  codexCredits,
  codexNumber,
  codexOutlook,
  codexReset,
  codexTokens,
  parseCodex,
} from "./codexUsage.ts";

const bucket = {
  calls: 859,
  totalInput: 1_200_000,
  output: 34_000,
  listCost: 7.15,
  incomplete: false,
};
const LIVE = {
  v: 1,
  computedAt: "2026-10-02T21:15:00Z",
  planLabel: "ChatGPT Pro (Codex)",
  planType: "pro",
  weekly: {
    usedFraction: 0,
    resetsAt: "2026-10-09T21:13:06Z",
    windowMinutes: 10080,
    capturedAt: "2026-10-02T21:13:06Z",
    stale: false,
    source: "codex-rollout",
    runway: null,
  },
  short: null,
  credits: { balance: 12345, unlimited: false, capturedAt: null },
  usage: {
    today: { direct: bucket, routed: { ...bucket, calls: 0, listCost: null } },
    last7d: {
      direct: bucket,
      routed: { ...bucket, calls: 6724, listCost: 13.23 },
    },
  },
};

test("Codex v1: zero weekly usage is a measured reading, not missing", () => {
  assert.deepEqual(parseCodex(LIVE), LIVE);
  assert.equal(parseCodex(LIVE).weekly.usedFraction, 0);
  assert.equal(parseCodex(LIVE).usage.today.routed.calls, 0);
});

test("Codex unknown windows and optional plan/credits stay null", () => {
  const unknown = {
    ...LIVE,
    weekly: null,
    short: null,
    credits: null,
    planLabel: null,
    planType: null,
  };
  assert.deepEqual(parseCodex(unknown), unknown);
});

test("Codex null or malformed numeric fields never become zero", () => {
  for (const value of [null, undefined, "0", false, NaN, Infinity, -0.1]) {
    const parsed = parseCodex({
      ...LIVE,
      weekly: { ...LIVE.weekly, usedFraction: value },
      credits: { balance: value, unlimited: null, capturedAt: null },
    });
    assert.equal(parsed.weekly.usedFraction, null);
    assert.equal(parsed.credits.balance, null);
  }
});

test("Codex stale weekly reading and shorter window preserve their numbers", () => {
  const weekly = { ...LIVE.weekly, usedFraction: 0.42, stale: true };
  const short = {
    ...LIVE.weekly,
    usedFraction: 0.25,
    windowMinutes: 300,
    source: "omniroute-quota",
  };
  const parsed = parseCodex({ ...LIVE, weekly, short });
  assert.deepEqual(parsed.weekly, weekly);
  assert.deepEqual(parsed.short, short);
});

test("Codex invalid dates and missing window metadata stay unknown", () => {
  const parsed = parseCodex({
    ...LIVE,
    weekly: {
      ...LIVE.weekly,
      resetsAt: "bad",
      capturedAt: 0,
      windowMinutes: "10080",
    },
    short: {},
  });
  assert.equal(parsed.weekly.resetsAt, null);
  assert.equal(parsed.weekly.capturedAt, null);
  assert.equal(parsed.weekly.windowMinutes, null);
  assert.equal(parsed.short, null);
});

test("Codex wrong version, missing history and non-record bodies are unavailable", () => {
  for (const value of [
    null,
    undefined,
    0,
    [],
    "",
    {},
    { ...LIVE, v: 2 },
    { ...LIVE, computedAt: "bad" },
    { ...LIVE, usage: {} },
  ]) {
    assert.equal(parseCodex(value), null);
  }
});

test("Codex missing or invalid required counters reject the bucket, never invent zero", () => {
  for (const field of ["calls", "totalInput", "output", "incomplete"]) {
    const raw = structuredClone(LIVE);
    raw.usage.last7d.direct[field] = null;
    assert.equal(parseCodex(raw), null);
  }
});

test("Codex unknown list cost and incomplete flag survive parsing", () => {
  const raw = structuredClone(LIVE);
  raw.usage.last7d.routed.listCost = null;
  raw.usage.last7d.routed.incomplete = true;
  assert.equal(parseCodex(raw).usage.last7d.routed.listCost, null);
  assert.equal(parseCodex(raw).usage.last7d.routed.incomplete, true);
});

test("Codex credits preserve unlimited, false and unknown booleans", () => {
  for (const unlimited of [true, false, null]) {
    const parsed = parseCodex({
      ...LIVE,
      credits: { balance: null, unlimited, capturedAt: null },
    });
    assert.equal(parsed.credits.unlimited, unlimited);
  }
  assert.equal(
    parseCodex({ ...LIVE, credits: { unlimited: "true" } }).credits.unlimited,
    null,
  );
});

test("Codex credits format unlimited, commas, zero and unknown distinctly", () => {
  assert.equal(codexCredits({ balance: null, unlimited: true }), "unlimited");
  assert.equal(codexCredits({ balance: 12345, unlimited: false }), "12,345");
  assert.equal(codexCredits({ balance: 0, unlimited: false }), "0");
  assert.equal(codexCredits({ balance: null, unlimited: null }), "—");
  assert.equal(codexCredits(null), "—");
});

test("Codex calls and compact token totals format measured zero", () => {
  assert.equal(codexNumber(6724), "6,724");
  assert.equal(codexNumber(0), "0");
  assert.equal(codexNumber(null), "—");
  assert.equal(codexTokens(1_200_000), "1.2M");
  assert.equal(codexTokens(34_000), "34K");
  assert.equal(codexTokens(0), "0");
});

test("Codex list cost distinguishes unknown and free; estimates have a tilde", () => {
  assert.equal(codexCost(null), "—");
  assert.equal(codexCost(null, true), "—");
  assert.equal(codexCost(0), "$0.00");
  assert.equal(codexCost(7.15), "$7.15");
  assert.equal(codexCost(13.23, true), "~$13.23");
});

test("Codex resets always include weekday and local time, unknown is a dash", () => {
  assert.equal(
    codexReset("2026-10-09T21:13:06Z", "America/Chicago"),
    "Fri 4:13 PM",
  );
  assert.equal(codexReset(null), "—");
  assert.equal(codexReset("invalid"), "—");
});

test("Codex fetch is a simple no-header GET to the shared hub with its abort signal", async (t) => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://pilot.tailb3d4b8.ts.net:6770/v1/codex");
    assert.equal(url, CODEX_URL);
    assert.deepEqual(options, { signal });
    return { ok: true, json: async () => LIVE };
  });
  assert.equal((await fetchCodex(signal)).weekly.usedFraction, 0);
});

test("Codex HTTP failures, network errors and bad JSON resolve to null", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
  assert.equal(await fetchCodex(), null);
  fetch.mock.mockImplementation(async () => {
    throw new Error("offline");
  });
  assert.equal(await fetchCodex(), null);
  fetch.mock.mockImplementation(async () => ({
    ok: true,
    json: async () => {
      throw new Error("bad JSON");
    },
  }));
  assert.equal(await fetchCodex(), null);
  fetch.mock.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ v: 1 }),
  }));
  assert.equal(await fetchCodex(), null);
});

test("Codex outlook: dry before reset, lasts to reset, or nothing without a projection", () => {
  const weekly = (runway, stale = false) =>
    parseCodex({
      ...LIVE,
      weekly: { ...LIVE.weekly, usedFraction: 0.32, stale, runway },
    }).weekly;
  const dry = weekly({
    burnPerHour: 0.0092,
    historyHours: 36,
    projectedAtReset: 1.72,
    dryAt: "2026-10-06T14:40:04Z",
  });
  assert.deepEqual(dry.runway, {
    burnPerHour: 0.0092,
    historyHours: 36,
    projectedAtReset: 1.72,
    dryAt: "2026-10-06T14:40:04Z",
  });
  assert.equal(codexOutlook(dry, "America/Chicago"), "dry Tue 9:40 AM");
  assert.equal(
    codexOutlook(
      weekly({
        burnPerHour: 0.001,
        historyHours: 72,
        projectedAtReset: 0.5,
        dryAt: null,
      }),
    ),
    "lasts to reset",
  );
  // Unknown projection (too little history) or a stale reading says nothing; the reset time stays.
  assert.equal(
    codexOutlook(
      weekly({
        burnPerHour: null,
        historyHours: 1,
        projectedAtReset: null,
        dryAt: null,
      }),
    ),
    null,
  );
  assert.equal(
    codexOutlook(
      weekly(
        {
          burnPerHour: 0.01,
          historyHours: 36,
          projectedAtReset: 1.2,
          dryAt: "2026-10-06T14:40:04Z",
        },
        true,
      ),
    ),
    null,
  );
  // An older hub without the runway key parses to null, never a fabricated "lasts".
  const { runway: _absent, ...older } = LIVE.weekly;
  const parsedOlder = parseCodex({ ...LIVE, weekly: older }).weekly;
  assert.equal(parsedOlder.runway, null);
  assert.equal(codexOutlook(parsedOlder), null);
});
