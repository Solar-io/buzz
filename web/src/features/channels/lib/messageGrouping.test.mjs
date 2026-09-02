import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MESSAGE_GROUPING_WINDOW_SECONDS,
  isWithinGroupingWindow,
} from "./messageGrouping.ts";

test("window constant matches the desktop's 10 minutes", () => {
  assert.equal(MESSAGE_GROUPING_WINDOW_SECONDS, 600);
});

test("gaps inside the window group; gaps outside break", () => {
  // Hardcoded expectations — never derived from the constant under test.
  assert.equal(isWithinGroupingWindow(1000, 1000), true); // same second
  assert.equal(isWithinGroupingWindow(1000, 1600), true); // exactly 10 min
  assert.equal(isWithinGroupingWindow(1000, 1601), false); // 10 min + 1s
  // The live incident shape: same author, hours apart on the same day.
  assert.equal(isWithinGroupingWindow(1000, 1000 + 8 * 3600), false);
});

test("missing or future timestamps are out of window", () => {
  assert.equal(isWithinGroupingWindow(null, 1000), false);
  assert.equal(isWithinGroupingWindow(undefined, 1000), false);
  assert.equal(isWithinGroupingWindow(1000, null), false);
  // Out-of-order arrival (current before previous) must not group.
  assert.equal(isWithinGroupingWindow(2000, 1000), false);
});

test("chained windows: each message compares against its immediate predecessor", () => {
  // 10:00, 10:08, 10:16 — every pairwise gap is 8 min, so all three chain.
  const at = [0, 480, 960];
  assert.equal(isWithinGroupingWindow(at[0], at[1]), true);
  assert.equal(isWithinGroupingWindow(at[1], at[2]), true);
  // But a 10:00 → 10:16 direct comparison would break — the chain, not the
  // span from the group head, is what matters. Pin that distinction.
  assert.equal(isWithinGroupingWindow(at[0], at[2]), false);
});
