import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCountdown, formatResetDay, headlineFor } from "./paceFormat.ts";

const NOW = Date.parse("2026-09-28T18:48:00Z");
const HOUR = 3_600_000;

test("formatResetDay honours the viewer time zone", () => {
  assert.equal(
    formatResetDay("2026-09-29T13:00:00Z", "America/Chicago"),
    "Tue 8 AM",
  );
  assert.equal(formatResetDay("2026-09-29T13:00:00Z", "UTC"), "Tue 1 PM");
});

test("formatCountdown: minutes, hours, days", () => {
  const at = (ms) => new Date(NOW + ms).toISOString();
  assert.equal(formatCountdown(at(18.2 * HOUR), NOW), "in 18h");
  assert.equal(formatCountdown(at(76 * HOUR), NOW), "in 3d");
  assert.equal(formatCountdown(at(45 * 60_000), NOW), "in 45m");
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
  assert.equal(headlineFor(pace, "UTC", NOW), "A runs out in ~3h");
});
