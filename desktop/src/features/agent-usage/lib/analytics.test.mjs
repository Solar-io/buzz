import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactTokens,
  exactTokens,
  money,
  tokenShare,
  csvDocument,
  selectedAgents,
  usageWindow,
  parseCivilDate,
  validateUsageSearch,
} from "./analytics.ts";
import { mockUsageAnalytics } from "../../../testing/e2eBridgeUsageAnalytics.ts";
import { sortUsageRows } from "../ui/UsageTable.tsx";

const A = "a".repeat(64);
const B = "b".repeat(64);
const now = new Date(2026, 8, 19, 16, 0);
const at = Math.floor(new Date(2026, 8, 19, 12).getTime() / 1000);
const reports = [
  {
    agent: A,
    at,
    input: "9007199254740993",
    output: "9",
    total: "9007199254741002",
    cost: 2,
    provider: "Anthropic",
    account: "Personal",
    model: "Claude",
  },
  {
    agent: B,
    at,
    input: "14",
    output: "6",
    total: "20",
    cost: 1,
    provider: "OpenAI",
    model: "GPT",
  },
];

test("decimal counters preserve all u64 digits", () => {
  assert.equal(
    exactTokens({ value: "18446744073709551615", incomplete: false }),
    BigInt("18446744073709551615").toLocaleString(),
  );
  assert.equal(compactTokens({ value: "1234567", incomplete: false }), "1.2M");
  assert.equal(compactTokens({ value: "1234567", incomplete: true }), "1.2M+");
});
test("unknown usage is distinct from reported zero", () => {
  assert.equal(compactTokens({ value: null, incomplete: true }), "—");
  assert.equal(compactTokens({ value: "0", incomplete: false }), "0");
  assert.equal(money({ value: null, incomplete: true }), "—");
  assert.equal(money({ value: 0, incomplete: false }), "$0.00");
});
test("display ratios preserve huge integer proportions", () => {
  assert.equal(tokenShare("9223372036854775807", "18446744073709551614"), 50);
});
test("agent keys are validated normalized and deduplicated", () => {
  assert.deepEqual(selectedAgents(`${B},${A.toUpperCase()},${A},junk`), [A, B]);
  assert.deepEqual(
    validateUsageSearch({ agents: A, range: "7D", start: 7, foreign: "x" }),
    { agents: A, range: "7D" },
  );
});
test("URL multi-selection is transmitted to the analytics query", () => {
  assert.deepEqual(
    usageWindow({ range: "7D", agents: `${B},${A}` }, now).request.agentPubkeys,
    [A, B],
  );
  assert.equal(
    usageWindow({ range: "7D", agents: "none" }, now).request.selectNone,
    true,
  );
  assert.equal(usageWindow({ range: "7D" }, now).request.selectNone, false);
});
test("one many all and none produce distinct global snapshots", () => {
  const request = usageWindow({ range: "7D" }, now).request;
  assert.ok(request);
  const all = mockUsageAnalytics(request, { reports });
  const one = mockUsageAnalytics(
    { ...request, agentPubkeys: [B] },
    { reports },
  );
  const many = mockUsageAnalytics(
    { ...request, agentPubkeys: [A, B] },
    { reports },
  );
  const none = mockUsageAnalytics(
    { ...request, selectNone: true },
    { reports },
  );
  assert.equal(all.summary.usage.totalTokens.value, "9007199254741022");
  assert.equal(one.summary.usage.totalTokens.value, "20");
  assert.equal(one.providers.length, 1);
  assert.equal(one.providers[0].label, "OpenAI");
  assert.equal(
    one.timeline.reduce((sum, row) => sum + row.reportCount, 0),
    1,
  );
  assert.deepEqual(many.summary, all.summary);
  assert.equal(none.summary.reportCount, 0);
  assert.equal(none.models.length, 0);
  assert.equal(none.availableAgents.length, 2);
});
test("all presets and custom inclusive last day create exact boundaries", () => {
  for (const [range, count] of [
    ["1D", 1],
    ["7D", 7],
    ["30D", 30],
    ["90D", 90],
    ["YTD", 262],
  ]) {
    assert.equal(usageWindow({ range }, now).request.dayLabels.length, count);
  }
  const custom = usageWindow(
    { range: "Custom", start: "2026-09-10", end: "2026-09-19" },
    now,
  ).request;
  assert.equal(custom.dayLabels.length, 10);
  assert.equal(custom.dayLabels.at(-1), "2026-09-19");
  assert.equal(
    usageWindow({ range: "All" }, now, at).request.dayLabels[0],
    "2026-09-19",
  );
});
test("invalid and reversed dates fail before IPC", () => {
  assert.equal(parseCivilDate("2026-02-30"), null);
  assert.ok(
    usageWindow(
      { range: "Custom", start: "2026-09-20", end: "2026-09-19" },
      now,
    ).error,
  );
  assert.ok(
    usageWindow({ range: "Custom", start: "", end: "2026-09-19" }, now).error,
  );
});
test("calendar boundaries preserve spring and fall DST", () => {
  const prior = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    const spring = usageWindow(
      { range: "Custom", start: "2026-03-08", end: "2026-03-08" },
      now,
    ).request;
    const fall = usageWindow(
      { range: "Custom", start: "2026-11-01", end: "2026-11-01" },
      now,
    ).request;
    assert.equal(spring.dayBoundaries[1] - spring.dayBoundaries[0], 23 * 3600);
    assert.equal(fall.dayBoundaries[1] - fall.dayBoundaries[0], 25 * 3600);
    assert.equal(spring.bucketBoundaries.length, 24);
    assert.equal(fall.bucketBoundaries.length, 26);
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
});
test("numeric sorting distinguishes adjacent values above MAX_SAFE_INTEGER", () => {
  const data = mockUsageAnalytics(usageWindow({ range: "7D" }, now).request, {
    reports,
  });
  const left = structuredClone(data.agents[0]);
  const right = structuredClone(data.agents[1]);
  left.usage.totalTokens.value = "9007199254740992";
  right.usage.totalTokens.value = "9007199254740993";
  assert.equal(sortUsageRows([left, right], "totalTokens", false)[0].key, B);
  assert.equal(sortUsageRows([left, right], "totalTokens", true)[0].key, A);
  assert.equal(sortUsageRows([left, right], "label", true, B).length, 1);
});
test("CSV preserves unknown cells exact integers quotes and prevents formula execution", () => {
  const csv = csvDocument(
    ["name", "count", "unknown"],
    [
      ["=1+2", "18446744073709551615", null],
      ['Model "A"', 1, false],
    ],
  );
  assert.ok(csv.includes('"\'=1+2"'));
  assert.ok(csv.includes('"18446744073709551615",""'));
  assert.ok(csv.includes('"Model ""A"""'));
  assert.ok(csv.includes("\r\n"));
});
