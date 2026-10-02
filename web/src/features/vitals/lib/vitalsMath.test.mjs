import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountDryText,
  accountRowText,
  accountVitals,
  paceLine,
  parseRunway,
  combinedHeadline,
  combinedRunway,
  combinedShort,
  pastResetSpan,
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
  assert.equal(
    combinedRunway(summary, old, Date.parse(LIVE_PACE.computedAt)),
    null,
  );
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

// ── Combined runway: when does the WHOLE pool run dry? (Sam, 2026-10-02) ───
// Sam's popover numbers that day: A 67 % used at 2.2 %/h, resets Tue
// Oct 6 8:00 AM CDT; B 1 % used at 0.4 %/h, resets Thu Oct 8 2:59 PM CDT;
// weekends ×1.5. Expected instants are worked by hand (in the comments) and
// hardcoded — never derived from the module's constants.

/** Sam's clock, pinned to his zone so the strings are deterministic. */
function chicago(iso) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function pool(rows, { weekendFactor = 1.5 } = {}) {
  const p = pace(
    rows.map((row) =>
      account({
        id: row.id,
        inUse: row.inUse ?? true,
        isDefault: row.id === "A",
        usedFraction: row.used,
        resetsAt: row.resetsAt,
      }),
    ),
  );
  const runway = parseRunway({
    v: 2,
    lookbackHours: 72,
    weekendFactor,
    status: "ok",
    accounts: rows.map((row) => ({
      id: row.id,
      usedFraction: row.used,
      resetsAt: row.resetsAt,
      historyHours: 72,
      burnPerHour: row.burn,
      projectedAtReset: 0.5,
      dryAt: null,
      status: "ok",
    })),
  });
  return { summary: vitalsSummary(p, runway), runway };
}

const SAM = [
  { id: "A", used: 0.67, burn: 0.022, resetsAt: "2026-10-06T13:00:00.000Z" },
  { id: "B", used: 0.01, burn: 0.004, resetsAt: "2026-10-08T19:59:00.000Z" },
];

function run(rows, nowIso, options) {
  const { summary, runway } = pool(rows, options);
  return combinedRunway(summary, runway, Date.parse(nowIso));
}

test("combined: all dry before any reset (Sam's numbers, Fri 7:04 AM CDT)", () => {
  // Fri 12:04Z → Sat 05:00Z (Chicago midnight) = 16.933 h × 2.6 %/h = 44.03 %;
  // 132 % − 44.03 % = 87.97 % at 3.9 %/h (weekend ×1.5) = 22.557 h → Sun 03:33:26Z.
  const combined = run(SAM, "2026-10-02T12:04:00.000Z");
  assert.equal(combined.kind, "dry");
  assert.deepEqual(combined.accounts, ["A", "B"]);
  assert.equal(combined.at, "2026-10-04T03:33:26.154Z");
  assert.equal(combined.pastReset, null, "lands before A's Tue reset");
  assert.deepEqual(combinedHeadline(combined, chicago), {
    lead: "Both run dry around ",
    strong: "Sat 10:33 PM",
    rest: "",
  });
  assert.equal(combinedShort(combined, chicago), "both dry Sat 10:33 PM");
});

test("combined: survives A's reset, dries days later (+N days)", () => {
  // Mon 11:00Z. A (soonest reset) drains first: 33 % / 2.6 %/h = 12.69 h;
  // then B until A's Tue 13:00Z reset → B at 35.6 %. A refills; B (now the
  // soonest reset) drains its 64.4 % by Wed 13:46Z; A drains until B's Thu
  // 19:59Z reset → A at 78.6 %. Thu 19:59Z → Sat 05:00Z eats 85.8 % of the
  // 121.4 % left; the last 35.6 % at 3.9 %/h = 9.128 h → Sat 14:07:41Z.
  const combined = run(SAM, "2026-10-05T11:00:00.000Z");
  assert.equal(combined.kind, "dry");
  assert.equal(combined.at, "2026-10-10T14:07:41.538Z");
  assert.deepEqual(combined.pastReset, {
    account: "A",
    at: "2026-10-06T13:00:00.000Z",
    ms: 349_661_538,
  });
  assert.deepEqual(combinedHeadline(combined, chicago), {
    lead: "Both run dry around ",
    strong: "Sat 9:07 AM",
    rest: " · +4 days past A's Tue 8:00 AM reset",
  });
  assert.equal(
    combinedShort(combined, chicago),
    "both dry Sat 9:07 AM · +4 days",
  );
});

test("combined: never dry within 14 days → lasts", () => {
  const combined = run(
    [
      { id: "A", used: 0.1, burn: 0.001, resetsAt: "2026-10-06T13:00:00.000Z" },
      { id: "B", used: 0.1, burn: 0.001, resetsAt: "2026-10-08T19:59:00.000Z" },
    ],
    "2026-10-05T11:00:00.000Z",
  );
  assert.deepEqual(combined, { kind: "lasts", accounts: ["A", "B"], days: 14 });
  assert.deepEqual(combinedHeadline(combined, chicago), {
    lead: "",
    strong: "Both last",
    rest: " 2+ weeks at your recent pace",
  });
  assert.equal(combinedShort(combined, chicago), "lasts 2+ wks");
});

test("combined: a parked account still counts (capacity and demand)", () => {
  // A parked (inUse false) — Sam's live case 2026-10-02. Pool = A + B:
  // 80 % + 50 % = 130 % room at 5 + 1 = 6 %/h on weekdays = 21 h 40 m
  // → Tue 2026-10-06 08:40Z (3:40 AM CDT). B alone would be Wed 13:00Z.
  const rows = [
    {
      id: "A",
      used: 0.2,
      burn: 0.05,
      resetsAt: "2026-10-12T13:00:00.000Z",
      inUse: false,
    },
    { id: "B", used: 0.5, burn: 0.01, resetsAt: "2026-10-09T11:00:00.000Z" },
  ];
  const combined = run(rows, "2026-10-05T11:00:00.000Z");
  assert.deepEqual(combined, {
    kind: "dry",
    accounts: ["A", "B"],
    at: "2026-10-06T08:40:00.000Z",
    pastReset: null,
  });
  assert.deepEqual(combinedHeadline(combined, chicago), {
    lead: "Both run dry around ",
    strong: "Tue 3:40 AM",
    rest: "",
  });
});

test("combined: weekend hours burn at the hub's weekendFactor", () => {
  const solo = [
    { id: "A", used: 0, burn: 0.02, resetsAt: "2026-10-09T13:00:00.000Z" },
  ];
  // From Sat 00:00 CDT: 100 % at 2 %/h × 1.5 = 33.33 h → Sun 14:20Z.
  const weekend = run(solo, "2026-10-03T05:00:00.000Z");
  assert.equal(weekend.at, "2026-10-04T14:20:00.000Z");
  // No factor: 50 h → Mon 07:00Z.
  const flat = run(solo, "2026-10-03T05:00:00.000Z", { weekendFactor: null });
  assert.equal(flat.at, "2026-10-05T07:00:00.000Z");
});

test("combined: nothing to simulate → null", () => {
  assert.equal(combinedRunway(vitalsSummary(null), null, 0), null);
  // No runway: no rates, so no pool.
  const bare = vitalsSummary(
    pace(SAM.map((row) => account({ id: row.id, usedFraction: row.used }))),
  );
  assert.equal(bare.kind, "known");
  assert.equal(
    combinedRunway(bare, null, Date.parse("2026-10-05T11:00:00.000Z")),
    null,
  );
});

test("past-reset span: hours under a day, rounded days beyond", () => {
  assert.equal(pastResetSpan(20 * 60_000), "+<1h");
  assert.equal(pastResetSpan(9 * 3_600_000), "+9h");
  assert.equal(pastResetSpan(30 * 3_600_000), "+1 day");
  assert.equal(pastResetSpan(43 * 3_600_000), "+2 days");
});

test("method line: 72 h average per account, short history noted", () => {
  assert.equal(
    runwayMethod(parseRunway(LIVE_RUNWAY)),
    "72h average, carried forward to each reset: A 1.4%/h · B 0.4%/h",
  );
  const weekend = structuredClone(LIVE_RUNWAY);
  weekend.weekendFactor = 1.5;
  assert.equal(
    runwayMethod(parseRunway(weekend)),
    "72h average, weekends ×1.5, carried forward to each reset: A 1.4%/h · B 0.4%/h",
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
