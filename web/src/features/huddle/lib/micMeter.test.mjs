import assert from "node:assert/strict";
import { test } from "node:test";
import { isSpeaking, micMeterFraction } from "./micMeter.ts";

test("silence and anything below the floor read as an empty bar", () => {
  assert.equal(micMeterFraction(-127), 0);
  assert.equal(micMeterFraction(-60), 0);
  assert.equal(micMeterFraction(-61), 0);
});

test("full scale is a full bar", () => {
  assert.equal(micMeterFraction(0), 1);
});

test("the floor is -60 dBov, so -30 is half", () => {
  // Hardcoded: a change to MIC_METER_FLOOR_DBOV must fail here rather than
  // silently rescale the meter with the assertion following it along.
  assert.equal(micMeterFraction(-30), 0.5);
  assert.equal(micMeterFraction(-15), 0.75);
});

test("nonsense input does not produce NaN width", () => {
  assert.equal(micMeterFraction(Number.NaN), 0);
  assert.equal(micMeterFraction(Number.POSITIVE_INFINITY), 0);
});

test("a level above 0 dBov cannot overflow the bar", () => {
  assert.equal(micMeterFraction(20), 1);
});

test("speaking threshold is -45 dBov", () => {
  assert.equal(isSpeaking(-44), true);
  assert.equal(
    isSpeaking(-45),
    false,
    "exactly at the threshold is not yet speech",
  );
  assert.equal(isSpeaking(-46), false);
  assert.equal(isSpeaking(-127), false);
});
