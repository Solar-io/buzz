import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountDryText,
  accountRowText,
  accountVitals,
  paceLine,
  parseRunway,
  runwayMethod,
  runwayOutlook,
  vitalsSummary,
} from "./vitalsMath.ts";

/**
 * Vitals v1 (phase-1 §4). The fixture is the live 2026-09-30 11:10Z sample
 * the design doc quotes; expected values are hardcoded, never derived from
 * the module's constants.
 */

function account(overrides) {
  return {
    id: "A",
    isDefault: true,
    inUse: true,
    state: "known",
    usedFraction: 0.02,
    resetsAt: "2026-10-06T12:59:00.000Z",
    elapsedFraction: 0.132,
    projectedAtReset: 0.165,
    etaFullAt: null,
    basis: "trailing-24h",
    status: "ok",
    ...overrides,
  };
}

function pace(accounts) {
  return {
    v: 1,
    computedAt: "2026-09-30T11:10:00.000Z",
    status: "ok",
    nextReset: null,
    headroomAccounts: null,
    headroomPartial: false,
    accounts,
  };
}

const LIVE = pace([
  account({ id: "A" }),
  account({
    id: "B",
    isDefault: false,
    usedFraction: 0.33,
    elapsedFraction: 0.805,
    projectedAtReset: 0.595,
    resetsAt: "2026-10-01T20:00:00.000Z",
  }),
]);

test("free = 1 − mean(known usedFraction); stale excluded and coverage reported", () => {
  const summary = vitalsSummary(LIVE);
  assert.equal(summary.kind, "known");
  assert.ok(Math.abs(summary.used - 0.175) < 1e-9);
  assert.ok(Math.abs(summary.free - 0.825) < 1e-9);
  assert.equal(summary.known, 2);
  assert.equal(summary.total, 2);

  // B goes stale: it leaves the mean — it is NOT a 0 % account.
  const stale = vitalsSummary(
    pace([
      account({ id: "A" }),
      account({ id: "B", state: "stale", usedFraction: null }),
    ]),
  );
  assert.equal(stale.kind, "known");
  assert.ok(Math.abs(stale.free - 0.98) < 1e-9, "A alone: 1 − 0.02");
  assert.equal(stale.known, 1);
  assert.equal(stale.total, 2, "coverage says 1 of 2");

  // Nothing known (the hub's state this morning): unavailable, never 0 %.
  const none = vitalsSummary(
    pace([
      account({ id: "A", state: "stale", usedFraction: null }),
      account({ id: "B", state: "stale", usedFraction: null }),
    ]),
  );
  assert.equal(none.kind, "unavailable");
  assert.equal(vitalsSummary(null).kind, "unavailable");
});

test("pace multiplier is null when elapsedFraction < 0.05", () => {
  const early = accountVitals(
    LIVE,
    account({ usedFraction: 0.04, elapsedFraction: 0.04 }),
  );
  assert.equal(early.paceMultiplier, null);
  const b = accountVitals(LIVE, LIVE.accounts[1]);
  assert.ok(Math.abs(b.paceMultiplier - 0.33 / 0.805) < 1e-9);
  assert.equal(paceLine(b), null, "0.41× is under the 1.1× line");
  const hot = accountVitals(
    LIVE,
    account({ id: "B", usedFraction: 0.48, elapsedFraction: 0.3 }),
  );
  assert.equal(paceLine(hot), "B is running at 1.6× its pace");
});

// ── /v1/runway v2: 72 h calendar-hour average, projected to each reset ─────
// computeRunway against a snapshot of the live hub DB at 2026-10-01T04:09Z
// (the same instant as the live /v1/pace below), verbatim but for rounding of
// the long floats. A burns 1.38 %/h of its week → full around 15:02Z, before
// its Oct 6 reset; B burns 0.42 %/h and lasts to its reset at ~43 %.
const LIVE_RUNWAY = {
  v: 2,
  basis: "weeklyAll",
  lookbackHours: 72,
  freeFraction: 0.79,
  status: "warn",
  accounts: [
    {
      id: "A",
      usedFraction: 0.85,
      resetsAt: "2026-10-06T13:00:00.000Z",
      historyHours: 71.841,
      burnPerHour: 0.01378,
      projectedAtReset: 2.6256,
      dryAt: "2026-10-01T15:02:14.645Z",
      status: "warn",
    },
    {
      id: "B",
      usedFraction: 0.36,
      resetsAt: "2026-10-01T19:59:00.000Z",
      historyHours: 71.471,
      burnPerHour: 0.0042,
      projectedAtReset: 0.4265,
      dryAt: null,
      status: "ok",
    },
  ],
  computedAt: "2026-10-01T04:09:08.544Z",
};
// /v1/pace at the same instant: its trailing-24 h model calls A critical.
function withStatus(status, accounts) {
  return { ...pace(accounts), status };
}
const LIVE_PACE = withStatus("critical", [
  account({
    id: "A",
    usedFraction: 0.85,
    resetsAt: "2026-10-06T13:00:00.000Z",
    elapsedFraction: 0.233,
    projectedAtReset: 5.385,
    etaFullAt: "2026-10-01T08:24:50.521Z",
    status: "critical",
  }),
  account({
    id: "B",
    isDefault: false,
    usedFraction: 0.36,
    resetsAt: "2026-10-01T19:59:00.000Z",
    elapsedFraction: 0.906,
    projectedAtReset: 0.38,
    status: "ok",
  }),
]);

test("parseRunway keeps the v2 per-account fields and drops off-shape entries", () => {
  const parsed = parseRunway(LIVE_RUNWAY);
  assert.equal(parsed.lookbackHours, 72);
  assert.equal(parsed.basis, "weeklyAll");
  assert.equal(parsed.status, "warn");
  assert.deepEqual(parsed.accounts[0], {
    id: "A",
    usedFraction: 0.85,
    resetsAt: "2026-10-06T13:00:00.000Z",
    historyHours: 71.841,
    burnPerHour: 0.01378,
    projectedAtReset: 2.6256,
    dryAt: "2026-10-01T15:02:14.645Z",
    status: "warn",
  });
  const messy = parseRunway({
    accounts: [
      { id: 7 },
      null,
      { id: "C", burnPerHour: "fast", status: "on fire" },
    ],
  });
  assert.equal(messy.accounts.length, 1);
  assert.equal(messy.accounts[0].burnPerHour, null);
  assert.equal(messy.accounts[0].status, "unknown");
  assert.equal(parseRunway("nope"), null);
});

test("a pre-v2 hub (active-hour fields) projects nothing", () => {
  const old = parseRunway({
    freeFraction: 1.28,
    ratePerActiveHour: 0.0648,
    activeHours: 8.33,
    runwayHours: 19.75,
    basis: "weeklyAll",
  });
  assert.deepEqual(old.accounts, []);
  assert.equal(runwayMethod(old), null);
  const summary = vitalsSummary(LIVE_PACE, old);
  assert.equal(runwayOutlook(summary), null);
  assert.equal(summary.accounts[0].dryAt, null);
});

test("account rows take the projection and its status from the runway", () => {
  const runway = parseRunway(LIVE_RUNWAY);
  const a = accountVitals(LIVE_PACE, LIVE_PACE.accounts[0], runway);
  assert.equal(a.dryAt, "2026-10-01T15:02:14.645Z");
  assert.equal(a.projectedAtReset, 2.6256);
  assert.equal(a.burnPerHour, 0.01378);
  assert.equal(a.historyHours, 71.841);
  assert.equal(a.status, "warn", "the 72 h projection, not pace's critical");
  const b = accountVitals(LIVE_PACE, LIVE_PACE.accounts[1], runway);
  assert.equal(b.dryAt, null);
  assert.equal(b.projectedAtReset, 0.4265);
  assert.equal(b.status, "ok");

  // No runway: no projection at all (pace's own ETA is not shown), pace status.
  const bare = accountVitals(LIVE_PACE, LIVE_PACE.accounts[0]);
  assert.equal(bare.dryAt, null);
  assert.equal(bare.projectedAtReset, null);
  assert.equal(bare.status, "critical");

  // A stale reading gets no projection even if the runway sent one.
  const stale = accountVitals(
    LIVE_PACE,
    account({ id: "A", state: "stale", usedFraction: null }),
    runway,
  );
  assert.equal(stale.dryAt, null);
  assert.equal(stale.projectedAtReset, null);
});

test("summary status: worst of the rows the runway coloured", () => {
  assert.equal(vitalsSummary(LIVE_PACE).status, "critical");
  assert.equal(
    vitalsSummary(LIVE_PACE, parseRunway(LIVE_RUNWAY)).status,
    "warn",
  );
  // A parked: pace's rule colours by the in-use rows only, and B's row is
  // coloured by the runway (warn), not by pace (ok).
  const parked = withStatus("critical", [
    { ...LIVE_PACE.accounts[0], inUse: false },
    LIVE_PACE.accounts[1],
  ]);
  const hotB = structuredClone(LIVE_RUNWAY);
  hotB.accounts[1].status = "warn";
  assert.equal(vitalsSummary(parked).status, "ok");
  assert.equal(vitalsSummary(parked, parseRunway(hotB)).status, "warn");
});

test("outlook: the soonest dry in-use account, else safe, else nothing", () => {
  const live = runwayOutlook(
    vitalsSummary(LIVE_PACE, parseRunway(LIVE_RUNWAY)),
  );
  assert.deepEqual(live, {
    kind: "dry",
    account: "A",
    at: "2026-10-01T15:02:14.645Z",
  });

  // Both dry: the earlier one (B) wins, whatever the order.
  const both = structuredClone(LIVE_RUNWAY);
  both.accounts[1].dryAt = "2026-10-01T09:30:00.000Z";
  assert.deepEqual(runwayOutlook(vitalsSummary(LIVE_PACE, parseRunway(both))), {
    kind: "dry",
    account: "B",
    at: "2026-10-01T09:30:00.000Z",
  });

  // Nobody dry: safe.
  const calm = structuredClone(LIVE_RUNWAY);
  calm.accounts[0].dryAt = null;
  calm.accounts[0].projectedAtReset = 0.97;
  assert.deepEqual(runwayOutlook(vitalsSummary(LIVE_PACE, parseRunway(calm))), {
    kind: "safe",
  });

  // A parked (switched-off) account running dry is not the headline.
  const parked = pace([
    { ...LIVE_PACE.accounts[0], inUse: false },
    LIVE_PACE.accounts[1],
  ]);
  assert.deepEqual(
    runwayOutlook(vitalsSummary(parked, parseRunway(LIVE_RUNWAY))),
    { kind: "safe" },
  );

  // No projection anywhere: no headline.
  const blind = structuredClone(LIVE_RUNWAY);
  for (const entry of blind.accounts) {
    entry.projectedAtReset = null;
    entry.dryAt = null;
  }
  assert.equal(
    runwayOutlook(vitalsSummary(LIVE_PACE, parseRunway(blind))),
    null,
  );
  assert.equal(runwayOutlook(vitalsSummary(null)), null);
});

test("method line: 72 h average per account, short history noted", () => {
  assert.equal(
    runwayMethod(parseRunway(LIVE_RUNWAY)),
    "72h average, carried forward to each reset: A 1.4%/h · B 0.4%/h",
  );
  const young = structuredClone(LIVE_RUNWAY);
  young.accounts[1].historyHours = 31.2;
  assert.equal(
    runwayMethod(parseRunway(young)),
    "72h average, carried forward to each reset: A 1.4%/h · B 0.4%/h (B: 31h of history)",
  );
  const empty = structuredClone(LIVE_RUNWAY);
  for (const entry of empty.accounts) {
    entry.burnPerHour = null;
  }
  assert.equal(
    runwayMethod(parseRunway(empty)),
    "not enough history in the last 72h to project yet",
  );
  assert.equal(runwayMethod(null), null);
});

test("row text: a red row says its reset and, below, when it runs dry; the default is marked active", () => {
  const runway = parseRunway(LIVE_RUNWAY);
  const fmt = (iso) => `<${iso}>`;
  const a = accountVitals(LIVE_PACE, LIVE_PACE.accounts[0], runway);
  const b = accountVitals(LIVE_PACE, LIVE_PACE.accounts[1], runway);
  assert.equal(a.active, true, "A is the pool default");
  assert.equal(b.active, false);
  assert.equal(a.status, "warn");
  assert.equal(
    accountRowText(a, fmt, "stale"),
    `${Math.round(a.used * 100)}% · resets <${a.resetsAt}>`,
    "the red row says its reset, like every other row",
  );
  assert.equal(accountDryText(a, fmt), "runs dry <2026-10-01T15:02:14.645Z>");
  assert.match(accountRowText(b, fmt, "stale"), /% · resets </);
  assert.equal(accountDryText(b, fmt), null, "an ok row has no dry line");
  const stale = accountVitals(
    LIVE_PACE,
    account({ id: "A", state: "stale", usedFraction: null }),
    runway,
  );
  assert.equal(accountRowText(stale, fmt, "stale"), "stale");
});
