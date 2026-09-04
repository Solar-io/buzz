import assert from "node:assert/strict";
import { test } from "node:test";
import { ephemeralDisplay, parseTtlDeadline } from "./ephemeralChannel.ts";

const NOW = 1_700_000_000;

test("a permanent channel has no badge", () => {
  assert.equal(
    ephemeralDisplay({ ttlSeconds: null, ttlDeadline: null }, NOW),
    null,
  );
});

test("parseTtlDeadline reads the relay's RFC-3339 stamp", () => {
  assert.equal(parseTtlDeadline("2023-11-14T22:13:20.000Z"), 1_699_999_999 + 1);
  assert.equal(parseTtlDeadline(null), null);
  assert.equal(parseTtlDeadline("not a date"), null);
});

test("minutes remaining read as minutes", () => {
  const display = ephemeralDisplay(
    {
      ttlSeconds: 3600,
      ttlDeadline: new Date((NOW + 12 * 60) * 1000).toISOString(),
    },
    NOW,
  );
  assert.equal(display.label, "12m left");
  assert.equal(display.secondsRemaining, 12 * 60);
  assert.equal(display.urgency, "normal");
});

test("over an hour reads as hours and minutes", () => {
  const display = ephemeralDisplay(
    {
      ttlSeconds: 7200,
      ttlDeadline: new Date((NOW + 3900) * 1000).toISOString(),
    },
    NOW,
  );
  assert.equal(display.label, "1h 5m left");
});

test("an exact hour drops the minutes", () => {
  const display = ephemeralDisplay(
    {
      ttlSeconds: 3600,
      ttlDeadline: new Date((NOW + 3600) * 1000).toISOString(),
    },
    NOW,
  );
  assert.equal(display.label, "1h left");
});

test("under five minutes escalates to soon", () => {
  const display = ephemeralDisplay(
    {
      ttlSeconds: 3600,
      ttlDeadline: new Date((NOW + 200) * 1000).toISOString(),
    },
    NOW,
  );
  assert.equal(display.label, "3m left");
  assert.equal(display.urgency, "soon");
});

test("six minutes out is still normal", () => {
  // Hardcoded either side of the 5-minute threshold rather than derived
  // from EPHEMERAL_SOON_SECONDS, so moving the constant fails this.
  const display = ephemeralDisplay(
    {
      ttlSeconds: 3600,
      ttlDeadline: new Date((NOW + 360) * 1000).toISOString(),
    },
    NOW,
  );
  assert.equal(display.urgency, "normal");
});

test("a passed deadline reads as expired, not as negative time", () => {
  const display = ephemeralDisplay(
    {
      ttlSeconds: 3600,
      ttlDeadline: new Date((NOW - 60) * 1000).toISOString(),
    },
    NOW,
  );
  assert.equal(display.label, "expired");
  assert.equal(display.secondsRemaining, 0);
  assert.equal(display.urgency, "expired");
});

test("a ttl with no parsable deadline still says the channel is temporary", () => {
  const display = ephemeralDisplay(
    { ttlSeconds: 3600, ttlDeadline: null },
    NOW,
  );
  assert.equal(display.label, "temporary");
  assert.equal(display.urgency, "normal");
});

test("seconds remaining read as seconds", () => {
  const display = ephemeralDisplay(
    {
      ttlSeconds: 60,
      ttlDeadline: new Date((NOW + 20) * 1000).toISOString(),
    },
    NOW,
  );
  assert.equal(display.label, "20s left");
});
