import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTitleBadge, stripTitleBadge } from "./titleBadge.ts";

test("a positive count is prefixed to the title", () => {
  assert.equal(formatTitleBadge("Buzz", 3), "(3) Buzz");
});

test("zero and negative counts leave the bare title", () => {
  assert.equal(formatTitleBadge("Buzz", 0), "Buzz");
  assert.equal(formatTitleBadge("Buzz", -1), "Buzz");
  assert.equal(formatTitleBadge("Buzz", Number.NaN), "Buzz");
});

// Hardcoded, not written as `TITLE_BADGE_MAX + 1` / `${TITLE_BADGE_MAX}+`:
// an expectation phrased in terms of the constant it pins moves with the
// constant and can never fail.
test("100 renders as 99+", () => {
  assert.equal(formatTitleBadge("Buzz", 100), "(99+) Buzz");
});

test("99 renders as itself", () => {
  assert.equal(formatTitleBadge("Buzz", 99), "(99) Buzz");
});

test("re-applying replaces the badge instead of nesting it", () => {
  const once = formatTitleBadge("Buzz", 1);
  const twice = formatTitleBadge(once, 2);
  assert.equal(twice, "(2) Buzz");
  assert.equal(formatTitleBadge(twice, 0), "Buzz");
});

test("a 99+ badge is also strippable", () => {
  assert.equal(stripTitleBadge("(99+) Buzz"), "Buzz");
  assert.equal(formatTitleBadge("(99+) Buzz", 2), "(2) Buzz");
});

test("stripping a title with no badge is a no-op", () => {
  assert.equal(stripTitleBadge("Buzz"), "Buzz");
  assert.equal(stripTitleBadge("Buzz (3)"), "Buzz (3)");
});
