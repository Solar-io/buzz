import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findRestriction,
  isTimedOut,
  parseRestrictionTimestampMs,
  restrictionFromRow,
} from "./restrictions.ts";

const PUBKEY = "ab".repeat(32);

function row(overrides) {
  return {
    pubkey: PUBKEY,
    banned: false,
    ban_expires_at: null,
    ban_reason: null,
    muted_until: null,
    mute_reason: null,
    actor_pubkey: "cd".repeat(32),
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("the snake_case wire row maps to the camelCase view model", () => {
  const mapped = restrictionFromRow(
    row({
      banned: true,
      ban_reason: "spam",
      muted_until: "2026-02-01T00:00:00Z",
      mute_reason: "cooling off",
    }),
  );
  assert.deepEqual(mapped, {
    pubkey: PUBKEY,
    banned: true,
    banExpiresAt: null,
    banReason: "spam",
    mutedUntil: "2026-02-01T00:00:00Z",
    muteReason: "cooling off",
  });
});

test("banned is a strict boolean, so a truthy string never reads as banned", () => {
  assert.equal(restrictionFromRow(row({ banned: false })).banned, false);
  assert.equal(restrictionFromRow(row({ banned: "false" })).banned, false);
  assert.equal(restrictionFromRow(row({ banned: true })).banned, true);
});

test("RFC3339 strings and unix-second numbers both parse", () => {
  assert.equal(
    parseRestrictionTimestampMs("2026-01-01T00:00:00Z"),
    Date.parse("2026-01-01T00:00:00Z"),
  );
  assert.equal(parseRestrictionTimestampMs(1_800_000_000), 1_800_000_000_000);
  for (const bad of [null, undefined, "not a date"]) {
    assert.equal(parseRestrictionTimestampMs(bad), null, String(bad));
  }
});

test("a timeout is active only while its expiry is in the future", () => {
  const now = Date.parse("2026-01-15T00:00:00Z");
  assert.equal(isTimedOut("2026-02-01T00:00:00Z", now), true);
  assert.equal(isTimedOut("2026-01-01T00:00:00Z", now), false);
  // Absent or unparseable is NOT an active timeout — the opposite default from
  // the send-rejection path, and deliberately so: here we have the moderator's
  // authoritative table, so silence means "no restriction".
  assert.equal(isTimedOut(null, now), false);
  assert.equal(isTimedOut("garbage", now), false);
});

test("lookup is case-insensitive and misses cleanly", () => {
  const rows = [restrictionFromRow(row({ banned: true }))];
  assert.equal(findRestriction(rows, PUBKEY.toUpperCase())?.banned, true);
  assert.equal(findRestriction(rows, "ef".repeat(32)), null);
  assert.equal(findRestriction(undefined, PUBKEY), null);
  assert.equal(findRestriction(rows, null), null);
});
