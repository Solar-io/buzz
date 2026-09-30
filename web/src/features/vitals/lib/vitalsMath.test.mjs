import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountVitals,
  formatRunway,
  paceLine,
  parseRunway,
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
