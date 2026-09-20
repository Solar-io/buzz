import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, usageWindow } from "./analytics.ts";
import { mockUsageAnalytics } from "../../../testing/e2eBridgeUsageAnalytics.ts";

const AGENT = "a".repeat(64);
const now = new Date(2026, 8, 19, 16);
const at = Math.floor(new Date(2026, 8, 19, 12).getTime() / 1000);

test("empty All range is bounded instead of allocating epoch-sized buckets", () => {
  const window = usageWindow({ range: "All" }, now, null);
  assert.equal(window.request.dayLabels.length, 30);
});

test("mock never fabricates provider total from input and output", () => {
  const request = usageWindow({ range: "1D" }, now).request;
  const data = mockUsageAnalytics(request, {
    reports: [{ agent: AGENT, at, input: "10", output: "5", cost: null }],
  });
  assert.equal(data.summary.usage.totalTokens.value, null);
  assert.equal(data.summary.usage.totalTokens.incomplete, true);
});

test("CSV formula defense handles whitespace and line breaks", () => {
  assert.equal(csvCell("  =1+2"), '"\'  =1+2"');
  assert.equal(csvCell("\n@SUM(A1)"), '"\'\n@SUM(A1)"');
});
