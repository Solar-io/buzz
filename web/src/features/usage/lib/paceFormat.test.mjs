import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeStatus,
  formatCountdown,
  formatResetDay,
  headlineFor,
  isParked,
} from "./paceFormat.ts";

const NOW = Date.parse("2026-09-28T18:48:00Z");
const HOUR = 3_600_000;

test("formatResetDay honours the viewer time zone", () => {
  assert.equal(
    formatResetDay("2026-09-29T13:00:00Z", "America/Chicago"),
    "Tue 8 AM",
  );
  assert.equal(formatResetDay("2026-09-29T13:00:00Z", "UTC"), "Tue 1 PM");
});

test("formatResetDay rounds a 7:59 reset to the nearest hour", () => {
  assert.equal(
    formatResetDay("2026-09-29T12:59:00Z", "America/Chicago"),
    "Tue 8 AM",
  );
});

test("formatCountdown: minutes, hours, days", () => {
  const at = (ms) => new Date(NOW + ms).toISOString();
  assert.equal(formatCountdown(at(18.2 * HOUR), NOW), "in 18h");
  assert.equal(formatCountdown(at(76 * HOUR), NOW), "in 3d");
  assert.equal(formatCountdown(at(45 * 60_000), NOW), "in 45m");
});

test("formatters return '' for unparseable dates instead of throwing", () => {
  assert.equal(formatResetDay("not-a-date", "America/Chicago"), "");
  assert.equal(formatCountdown("not-a-date", NOW), "");
});

test("headlineFor critical on an exhausted account says it is out", () => {
  const pace = {
    v: 1,
    computedAt: "",
    status: "critical",
    nextReset: null,
    headroomAccounts: 0,
    headroomPartial: false,
    accounts: [
      {
        id: "A",
        isDefault: true,
        state: "known",
        usedFraction: 1,
        resetsAt: null,
        elapsedFraction: 0.9,
        projectedAtReset: 1,
        etaFullAt: new Date(NOW + 3 * HOUR).toISOString(),
        basis: "trailing-24h",
        status: "critical",
      },
    ],
  };
  assert.equal(headlineFor(pace, NOW), "A is out");
});

test("headlineFor critical names the account and its ETA", () => {
  const pace = {
    v: 1,
    computedAt: "",
    status: "critical",
    nextReset: null,
    headroomAccounts: 0.03,
    headroomPartial: false,
    accounts: [
      {
        id: "A",
        isDefault: true,
        state: "known",
        usedFraction: 0.97,
        resetsAt: null,
        elapsedFraction: 0.9,
        projectedAtReset: 1.15,
        etaFullAt: new Date(NOW + 3 * HOUR).toISOString(),
        basis: "trailing-24h",
        status: "critical",
      },
    ],
  };
  assert.equal(headlineFor(pace, NOW), "A runs out in ~3h");
});

function acct(overrides) {
  return {
    id: "A",
    isDefault: true,
    inUse: null,
    state: "known",
    usedFraction: 0.5,
    resetsAt: null,
    elapsedFraction: 0.5,
    projectedAtReset: 0.6,
    etaFullAt: null,
    basis: "trailing-24h",
    status: "ok",
    ...overrides,
  };
}

function paceOf(status, accounts) {
  return {
    v: 1,
    computedAt: "",
    status,
    nextReset: null,
    headroomAccounts: 1,
    headroomPartial: false,
    accounts,
  };
}

test("isParked prefers the hub's inUse over isDefault", () => {
  const a = acct({ isDefault: false, inUse: true });
  const b = acct({ id: "B", isDefault: true, inUse: true });
  assert.equal(isParked(paceOf("ok", [a, b]), a), false);
  const idle = acct({ isDefault: true, inUse: false });
  assert.equal(isParked(paceOf("ok", [idle, b]), idle), true);
});

test("isParked falls back to 'not default while another is'", () => {
  const a = acct({ isDefault: false });
  const b = acct({ id: "B", isDefault: true });
  const pace = paceOf("ok", [a, b]);
  assert.equal(isParked(pace, a), true);
  assert.equal(isParked(pace, b), false);
  const noDefault = acct({ isDefault: false });
  assert.equal(isParked(paceOf("ok", [noDefault]), noDefault), false);
});

test("activeStatus ignores a parked critical pool", () => {
  const pace = paceOf("critical", [
    acct({ inUse: false, status: "critical", usedFraction: 0.99 }),
    acct({ id: "B", inUse: true, status: "warn" }),
  ]);
  assert.equal(activeStatus(pace), "warn");
  assert.equal(headlineFor(pace, NOW), "B runs out before reset");
});

test("activeStatus keeps the hub status when nothing is parked or all are", () => {
  const both = paceOf("critical", [
    acct({ inUse: true, status: "critical" }),
    acct({ id: "B", inUse: true }),
  ]);
  assert.equal(activeStatus(both), "critical");
  const none = paceOf("warn", [acct({ inUse: false, status: "warn" })]);
  assert.equal(activeStatus(none), "warn");
});
