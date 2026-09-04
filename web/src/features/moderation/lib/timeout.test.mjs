import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTimeoutRemaining,
  isTimeoutActive,
  parseTimeoutRejection,
  TIMEOUT_PRESETS,
  timeoutExpiresAt,
} from "./timeout.ts";

test("the relay's timeout refusal is recognized and its expiry read", () => {
  // Verbatim shape from handlers/ingest.rs.
  const parsed = parseTimeoutRejection(
    "restricted: you are timed out until 1800000000",
  );
  assert.deepEqual(parsed, { expiresAtMs: 1_800_000_000_000 });
});

test("a different rejection is NOT treated as a timeout", () => {
  // Discriminating: a parser that returned a truthy value for anything would
  // arm the banner on an ordinary failure and lock the composer.
  for (const message of [
    "blocked: you are banned from this community",
    "invalid: report target event not found",
    "restricted: moderator access required",
    "",
    null,
    undefined,
  ]) {
    assert.equal(parseTimeoutRejection(message), null, String(message));
  }
});

test("a malformed trailing timestamp still counts as timed out", () => {
  for (const tail of ["", "soon", "-5", "0"]) {
    assert.deepEqual(
      parseTimeoutRejection(`restricted: you are timed out until ${tail}`),
      { expiresAtMs: null },
      tail,
    );
  }
});

test("an unknown expiry fails closed to still-active", () => {
  assert.equal(isTimeoutActive(null, 1_000), true);
  assert.equal(isTimeoutActive(2_000, 1_000), true);
  assert.equal(isTimeoutActive(1_000, 1_000), false);
  assert.equal(isTimeoutActive(500, 1_000), false);
});

test("the countdown formats hours, minutes and seconds", () => {
  const now = 1_000_000;
  assert.equal(
    formatTimeoutRemaining(now + 2 * 3600_000 + 5 * 60_000, now),
    "2h 5m",
  );
  assert.equal(
    formatTimeoutRemaining(now + 3 * 60_000 + 20_000, now),
    "3m 20s",
  );
  assert.equal(formatTimeoutRemaining(now + 12_000, now), "12s");
});

test("there is no countdown for an unknown or elapsed expiry", () => {
  assert.equal(formatTimeoutRemaining(null, 1_000), null);
  assert.equal(formatTimeoutRemaining(1_000, 1_000), null);
  assert.equal(formatTimeoutRemaining(0, 1_000), null);
});

test("presets resolve to now + duration in epoch seconds", () => {
  const nowMs = 1_700_000_000_000;
  assert.equal(timeoutExpiresAt(3600, nowMs), 1_700_000_000 + 3600);
  // Hardcoded, not derived: the durations are the product contract.
  assert.deepEqual(
    TIMEOUT_PRESETS.map((preset) => preset.seconds),
    [3600, 86400, 604800],
  );
  assert.deepEqual(
    TIMEOUT_PRESETS.map((preset) => preset.label),
    ["1 hour", "24 hours", "7 days"],
  );
});
