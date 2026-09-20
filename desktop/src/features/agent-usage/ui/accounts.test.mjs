import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { mockUsageAnalytics } from "../../../testing/e2eBridgeUsageAnalytics.ts";
import {
  SEEDED_MARKER,
  accountRowLabel,
  confirmedCsvCell,
  isProvisionalAccount,
  provisionalAccountCount,
} from "../lib/accounts.ts";
import { usageWindow } from "../lib/analytics.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});
let render,
  cleanup,
  fireEvent,
  createElement,
  UsageTable,
  UsageCoverage,
  usageCsv;
before(async () => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  ({ render, cleanup, fireEvent } = await import("@testing-library/react"));
  ({ createElement } = await import("react"));
  ({ UsageTable } = await import("./UsageTable.tsx"));
  ({ UsageCoverage } = await import("./UsageSummary.tsx"));
  ({ usageCsv } = await import("./AgentUsagePage.tsx"));
});
beforeEach(() => cleanup?.());
after(() => {
  cleanup?.();
  dom.window.close();
});

/**
 * Three accounts that DIFFER in confirmation state, so every assertion below
 * discriminates rather than agreeing with itself:
 *  - `zai-coding-plan`  confirmed
 *  - `harness=claude`   seeded, unconfirmed
 *  - no account at all  the unknown bucket
 */
function fixture() {
  const now = new Date(2026, 8, 19, 16);
  const at = Math.floor(new Date(2026, 8, 19, 12).getTime() / 1000);
  return mockUsageAnalytics(usageWindow({ range: "7D" }, now).request, {
    reports: [
      {
        agent: "a".repeat(64),
        at,
        input: "900",
        output: "100",
        total: "1000",
        cost: 10,
        account: "zai-coding-plan",
        accountConfirmed: true,
      },
      {
        agent: "b".repeat(64),
        at,
        input: "90",
        output: "10",
        total: "100",
        cost: 1,
        account: "harness=claude",
        accountConfirmed: false,
      },
      { agent: "c".repeat(64), at, input: null, output: null, cost: null },
    ],
  });
}

function account(data, key) {
  const row = data.accounts.find((candidate) => candidate.key === key);
  assert.ok(row, `fixture must produce an account for ${key}`);
  return row;
}

test("the fixture distinguishes confirmed, seeded and unreported accounts", () => {
  const data = fixture();
  assert.equal(data.accounts.length, 3);
  assert.equal(account(data, "zai-coding-plan").confirmed, true);
  assert.equal(account(data, "harness=claude").confirmed, false);
  assert.equal(account(data, "__unknown__").confirmed, false);
  assert.equal(data.coverage.accountReports, 2);
  assert.equal(data.coverage.confirmedAccountReports, 1);
});

test("a seeded account renders as provisional and a confirmed one does not", () => {
  const data = fixture();
  assert.equal(
    accountRowLabel(account(data, "harness=claude")),
    `harness=claude · ${SEEDED_MARKER}`,
  );
  assert.equal(
    accountRowLabel(account(data, "zai-coding-plan")),
    "zai-coding-plan",
  );
  // The unreported bucket claims no identity, so it is not "provisional" —
  // it keeps the page's existing Not-reported wording.
  assert.equal(accountRowLabel(account(data, "__unknown__")), "Not reported");
  assert.equal(isProvisionalAccount(account(data, "harness=claude")), true);
  assert.equal(isProvisionalAccount(account(data, "zai-coding-plan")), false);
  assert.equal(isProvisionalAccount(account(data, "__unknown__")), false);
  assert.equal(provisionalAccountCount(data.accounts), 1);
});

test("the account table shows the provisional marker on seeded rows only", () => {
  const data = fixture();
  const rows = data.accounts.map((row) => ({
    ...row,
    label: accountRowLabel(row),
  }));
  const view = render(
    createElement(UsageTable, {
      title: "Account breakdown",
      dimension: "Account",
      rows,
      total: data.summary.usage.totalTokens.value,
    }),
  );
  const cells = [...view.container.querySelectorAll("tbody th")].map(
    (cell) => cell.textContent,
  );
  assert.equal(cells.length, 3);
  assert.deepEqual(cells, [
    "zai-coding-plan",
    `harness=claude · ${SEEDED_MARKER}`,
    "Not reported",
  ]);
  assert.equal(
    cells.filter((cell) => cell.includes(SEEDED_MARKER)).length,
    1,
    "exactly one row is provisional",
  );
});

test("account search and sort still scope the account dimension", () => {
  const data = fixture();
  const rows = data.accounts.map((row) => ({
    ...row,
    label: accountRowLabel(row),
  }));
  const view = render(
    createElement(UsageTable, {
      title: "Account breakdown",
      dimension: "Account",
      rows,
      total: data.summary.usage.totalTokens.value,
    }),
  );
  const cells = () =>
    [...view.container.querySelectorAll("tbody th")].map(
      (cell) => cell.textContent,
    );
  // Searching the marker finds the seeded accounts and nothing else.
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: SEEDED_MARKER },
  });
  assert.deepEqual(cells(), [`harness=claude · ${SEEDED_MARKER}`]);
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "zai" },
  });
  assert.deepEqual(cells(), ["zai-coding-plan"]);
  fireEvent.change(view.getByRole("textbox"), { target: { value: "" } });
  fireEvent.click(view.getByRole("button", { name: "Total" }));
  assert.deepEqual(cells(), [
    `harness=claude · ${SEEDED_MARKER}`,
    "zai-coding-plan",
    "Not reported",
  ]);
});

test("coverage reports confirmed accounts apart from attributed accounts", () => {
  const data = fixture();
  const view = render(createElement(UsageCoverage, { data }));
  assert.ok(view.getByText("Account"));
  assert.ok(view.getByText("Confirmed account"));
  const value = (term) =>
    [...view.container.querySelectorAll(".usage-coverage-grid > div")]
      .find((entry) => entry.querySelector("dt").textContent === term)
      .querySelector("dd").textContent;
  assert.equal(value("Account"), "2 / 3 turns");
  assert.equal(
    value("Confirmed account"),
    "1 / 3 turns",
    "confirmed must not equal attributed",
  );
});

test("CSV export carries the account dimension and its confirmation state", () => {
  const data = fixture();
  const csv = usageCsv({
    ...data,
    accounts: data.accounts.map((row) => ({
      ...row,
      label: accountRowLabel(row),
    })),
  });
  const header = csv.split("\r\n")[0];
  assert.ok(header.endsWith('"owner_confirmed"'), header);
  const rows = csv
    .split("\r\n")
    .filter((line) => line.startsWith('"account"'))
    .map((line) => line.split(","));
  assert.equal(rows.length, 3, "every account row is exported");
  const byKey = new Map(rows.map((row) => [row[1], row.at(-1)]));
  assert.equal(byKey.get('"zai-coding-plan"'), '"confirmed"');
  assert.equal(byKey.get('"harness=claude"'), `"${SEEDED_MARKER}"`);
  assert.equal(
    byKey.get('"__unknown__"'),
    '""',
    "an unreported account has no confirmation state to export",
  );
  // Other dimensions have no confirmation state and must not claim one.
  for (const line of csv.split("\r\n").filter((l) => l.startsWith('"agent"')))
    assert.ok(line.endsWith(',""'), line);
});

test("confirmedCsvCell only speaks for the account dimension", () => {
  assert.equal(confirmedCsvCell("account", { confirmed: true }), "confirmed");
  assert.equal(
    confirmedCsvCell("account", { confirmed: false }),
    SEEDED_MARKER,
  );
  assert.equal(confirmedCsvCell("provider", { confirmed: true }), "");
  assert.equal(confirmedCsvCell("model", { confirmed: false }), "");
  assert.equal(
    confirmedCsvCell("account", { confirmed: false, key: "__unknown__" }),
    "",
  );
});
