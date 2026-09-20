import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { mockUsageAnalytics } from "../../../testing/e2eBridgeUsageAnalytics.ts";
import { usageWindow } from "../lib/analytics.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});
let render,
  act,
  fireEvent,
  cleanup,
  createElement,
  UsageTable,
  UsageSummary,
  UsageCoverage,
  Diversity,
  Timeline;
before(async () => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  ({ render, fireEvent, cleanup, act } = await import(
    "@testing-library/react"
  ));
  ({ createElement } = await import("react"));
  ({ UsageTable } = await import("./UsageTable.tsx"));
  ({ UsageSummary, UsageCoverage, Diversity } = await import(
    "./UsageSummary.tsx"
  ));
  ({ Timeline } = await import("./UsageCharts.tsx"));
});
beforeEach(() => cleanup?.());
after(() => {
  cleanup?.();
  dom.window.close();
});
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
        provider: "Provider A",
        model: "Model A",
      },
      {
        agent: "b".repeat(64),
        at,
        input: "90",
        output: "10",
        total: "100",
        cost: 1,
        provider: "Provider B",
        model: "Model B",
      },
      { agent: "c".repeat(64), at, input: null, output: null, cost: null },
    ],
  });
}
test("table headers change numeric order and search scopes visible rows", () => {
  const data = fixture();
  const view = render(
    createElement(UsageTable, {
      title: "Provider breakdown",
      dimension: "Provider",
      rows: data.providers,
      total: data.summary.usage.totalTokens.value,
    }),
  );
  const cells = () =>
    [...view.container.querySelectorAll("tbody th")].map(
      (cell) => cell.textContent,
    );
  assert.deepEqual(cells(), ["Provider A", "Provider B", "Not reported"]);
  fireEvent.click(view.getByRole("button", { name: "Total" }));
  assert.deepEqual(cells(), ["Provider B", "Provider A", "Not reported"]);
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Provider A" },
  });
  assert.deepEqual(cells(), ["Provider A"]);
  fireEvent.change(view.getByRole("textbox"), { target: { value: "missing" } });
  assert.ok(view.getByText("No matching rows. Try another search."));
});
test("headline reports turns and leaves unknown requests unreported", () => {
  const data = fixture();
  const view = render(createElement(UsageSummary, { data }));
  assert.equal(view.getByTestId("usage-total").textContent, "1.1K+");
  assert.ok(view.getByText("3 Turns · Requests not reported"));
  assert.equal(
    view.getByTestId("usage-cost").textContent,
    "Wire $11.00+ · Manifest —",
  );
});
test("headline never invents total tokens from reported input and output", () => {
  const data = fixture();
  data.summary.usage.totalTokens = { value: null, incomplete: true };
  const view = render(createElement(UsageSummary, { data }));
  assert.equal(view.getByTestId("usage-total").textContent, "—");
  assert.ok(view.getByText("990+"));
});
test("the I/O ratio is marked partial exactly when its band-neighbours are", () => {
  const value = (view, label) =>
    view.getByText(label).nextElementSibling.textContent;
  // The fixture has one all-null report, so every total is partial. The ratio
  // must say so too: it was a complete input over a partial output, rendered
  // as a confident number.
  const partialView = render(createElement(UsageSummary, { data: fixture() }));
  assert.equal(value(partialView, "I/O ratio"), "9× (partial)");
  assert.equal(value(partialView, "Avg tokens / turn"), "366+");
  assert.equal(value(partialView, "Cost / turn"), "$3.67+");
  cleanup();

  // Complete populations on both sides: no marker at all. This is the half
  // that makes the assertion above discriminate.
  const complete = fixture();
  complete.summary.usage.inputTokens = { value: "990", incomplete: false };
  complete.summary.usage.outputTokens = { value: "110", incomplete: false };
  const completeView = render(createElement(UsageSummary, { data: complete }));
  assert.equal(value(completeView, "I/O ratio"), "9×");
});
test("provenance displays wire estimates unknown separately", () => {
  const data = fixture();
  data.summary.costs.wireReported = { value: 4, incomplete: false };
  data.summary.costs.manifestEstimated = { value: 7, incomplete: false };
  const view = render(createElement(UsageCoverage, { data }));
  assert.ok(view.getByText("$4.00"));
  assert.ok(view.getByText("$7.00"));
  assert.ok(view.getByText(/Unknown source/));
});
test("diversity reports percent scale and never fabricates empty recent score", () => {
  const view = render(createElement(Diversity, { data: fixture() }));
  assert.ok(view.getByText("100.0%"));
  assert.ok(view.getByText("No attributed usage in this window."));
  assert.ok(view.getByText(/Provider known for 2 of 3 turns/));
});
test("timeline focus reveals exact values and arrows move real focus", () => {
  const data = fixture();
  const view = render(createElement(Timeline, { buckets: data.timeline }));
  const bars = view.getAllByRole("button");
  fireEvent.focus(bars.at(-1));
  assert.match(
    view.container.querySelector("[aria-live]").textContent,
    /Input 990/,
  );
  act(() => bars[0].focus());
  fireEvent.keyDown(bars[0], { key: "ArrowRight" });
  assert.equal(document.activeElement, bars[1]);
  assert.equal(view.container.querySelectorAll("tbody tr").length, 7);
});
