import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountVitals,
  formatRunway,
  paceLine,
  parseRunway,
  runDryNote,
  runwayMethod,
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

test("resets-unused hidden when etaFullAt is set", () => {
  assert.equal(accountVitals(LIVE, LIVE.accounts[0]).unusedAtReset, 84);
  // 1 − 0.595 = 0.405 → 40.5 rounds half-up to 41 (the design doc's "40" is
  // its own sample arithmetic, not the rule).
  assert.equal(accountVitals(LIVE, LIVE.accounts[1]).unusedAtReset, 41);
  const filling = accountVitals(
    LIVE,
    account({
      projectedAtReset: 0.5,
      etaFullAt: "2026-10-01T17:08:00.000Z",
      resetsAt: "2026-10-06T12:59:00.000Z",
    }),
  );
  assert.equal(filling.unusedAtReset, null);
  assert.equal(filling.fillsAt, "2026-10-01T17:08:00.000Z");
  // An ETA after the reset is not a "fills around".
  const late = accountVitals(
    LIVE,
    account({ etaFullAt: "2026-10-09T00:00:00.000Z" }),
  );
  assert.equal(late.fillsAt, null);
});

test("runway line reads the hub and hides when it cannot say", () => {
  assert.equal(
    formatRunway(parseRunway({ runwayHours: 2.8333333 })),
    "~2h 50m",
  );
  assert.equal(formatRunway(parseRunway({ runwayHours: 0.5 })), "~30m");
  // The live hub this morning: runwayHours null.
  assert.equal(
    formatRunway(
      parseRunway({
        freeFraction: null,
        ratePerActiveHour: 0.0614,
        activeHours: 7.17,
        runwayHours: null,
      }),
    ),
    null,
  );
  assert.equal(parseRunway("nope"), null);
});

// ── Phase 4: /v1/runway in the popover ─────────────────────────────────────
// The live hub at 2026-09-30T19:01Z, verbatim (curl receipt in the Phase 4
// report): 1.28 accounts free, 6.48 % of one account per active hour.
const LIVE_RUNWAY = {
  freeFraction: 1.28,
  ratePerActiveHour: 0.0648,
  activeHours: 8.333333333333334,
  runwayHours: 19.75308641975309,
  basis: "weeklyAll",
  computedAt: "2026-09-30T19:01:36.257Z",
};
const NOW = Date.parse("2026-09-30T19:01:36.000Z");

test("parseRunway keeps the hub's fields, basis included", () => {
  assert.deepEqual(parseRunway(LIVE_RUNWAY), {
    freeFraction: 1.28,
    ratePerActiveHour: 0.0648,
    activeHours: 8.333333333333334,
    runwayHours: 19.75308641975309,
    basis: "weeklyAll",
  });
  assert.equal(parseRunway({ basis: 7 }).basis, null);
});

test("the runway reads in hours, then in days past two days", () => {
  assert.equal(formatRunway(parseRunway(LIVE_RUNWAY)), "~19h 45m");
  assert.equal(formatRunway(parseRunway({ runwayHours: 47.99 })), "~47h 59m");
  assert.equal(formatRunway(parseRunway({ runwayHours: 76.2 })), "~3d 4h");
});

test("method line: the hub's own rate and active hours", () => {
  assert.equal(
    runwayMethod(parseRunway(LIVE_RUNWAY)),
    "runway = free ÷ use per active hour · 48h: 6.5%/h over 8.3 active h",
  );
  assert.equal(
    runwayMethod(
      parseRunway({
        ratePerActiveHour: 0.162,
        activeHours: 18.2,
        runwayHours: 2.83,
      }),
    ),
    "runway = free ÷ use per active hour · 48h: 16%/h over 18 active h",
  );
  // Under three active intervals the hub sends no runway: say so, no rate.
  assert.equal(
    runwayMethod(
      parseRunway({
        ratePerActiveHour: 0.03,
        activeHours: 0.3,
        runwayHours: null,
      }),
    ),
    "runway: too little active use in the last 48h to estimate",
  );
  assert.equal(runwayMethod(null), null);
  assert.equal(runwayMethod(parseRunway({})), null);
});

test("you won't run dry only when the next reset lands inside the runway", () => {
  // B resets 2026-10-01T19:59Z — 24.96 h away; the runway is 19.75 active h.
  // Worked without a break the runway ends first, so this is NOT safe.
  const live = runDryNote(
    parseRunway(LIVE_RUNWAY),
    { account: "B", resetsAt: "2026-10-01T19:59:00.000Z" },
    NOW,
  );
  assert.deepEqual(live, {
    kind: "tight",
    account: "B",
    resetsAt: "2026-10-01T19:59:00.000Z",
  });
  // The same runway with a reset 6 h out: well inside (6 ≤ 19.75 / 2).
  assert.deepEqual(
    runDryNote(
      parseRunway(LIVE_RUNWAY),
      { account: "A", resetsAt: "2026-10-01T01:01:36.000Z" },
      NOW,
    ),
    {
      kind: "safe",
      account: "A",
      resetsAt: "2026-10-01T01:01:36.000Z",
      well: true,
    },
  );
  // 15 h out: inside, but not "well" inside.
  assert.equal(
    runDryNote(
      parseRunway(LIVE_RUNWAY),
      { account: "A", resetsAt: "2026-10-01T10:01:36.000Z" },
      NOW,
    ).well,
    false,
  );
});

test("no runway, no reset, or a reset already past: no run-dry line", () => {
  const reset = { account: "B", resetsAt: "2026-10-01T00:00:00.000Z" };
  assert.equal(
    runDryNote(parseRunway({ runwayHours: null }), reset, NOW),
    null,
  );
  assert.equal(runDryNote(null, reset, NOW), null);
  assert.equal(runDryNote(parseRunway(LIVE_RUNWAY), null, NOW), null);
  assert.equal(
    runDryNote(
      parseRunway(LIVE_RUNWAY),
      { account: "B", resetsAt: "2026-09-30T18:00:00.000Z" },
      NOW,
    ),
    null,
  );
});
