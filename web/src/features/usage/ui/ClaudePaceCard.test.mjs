/**
 * ClaudePaceCard renders usage-hub `/v1/pace` in the sidebar: one headline,
 * a thin bar per account with a week-elapsed tick, a headroom line, and a
 * link to usage-hub. Unknown usage is never shown as 0%, and a failed fetch
 * renders nothing at all.
 *
 * The usage-hub client is faked via the test-loader's module-stub seam; the
 * component and formatters are real.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

globalThis.__PACE_TEST_RESULT__ = null;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/features/usage/lib/usageHub":
    'export const USAGE_HUB_URL = "https://pilot.tailb3d4b8.ts.net:6770";\n' +
    "export async function fetchPace() { return globalThis.__PACE_TEST_RESULT__; }",
};

const { default: React, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const mod = await import("./ClaudePaceCard.tsx");

after(() => dom.window.close());

function account(overrides) {
  return {
    id: "A",
    isDefault: true,
    state: "known",
    usedFraction: 0.92,
    resetsAt: "2026-09-29T13:00:00Z",
    elapsedFraction: 0.892,
    projectedAtReset: 0.935,
    etaFullAt: null,
    basis: "trailing-24h",
    status: "ok",
    ...overrides,
  };
}

function pace(overrides) {
  return {
    v: 1,
    computedAt: "2026-09-28T18:48:00Z",
    status: "ok",
    nextReset: { account: "A", resetsAt: "2026-09-29T13:00:00Z" },
    headroomAccounts: 1.02,
    headroomPartial: false,
    accounts: [
      account({}),
      account({
        id: "B",
        isDefault: false,
        usedFraction: 0.06,
        resetsAt: "2026-10-01T20:00:00Z",
        elapsedFraction: 0.42,
      }),
    ],
    ...overrides,
  };
}

async function render(result) {
  globalThis.__PACE_TEST_RESULT__ = result;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(mod.ClaudePaceCard, {
        timeZone: "America/Chicago",
        now: NOW,
      }),
    );
  });
  return { container, root };
}

// Fixed clock: 2026-09-28T18:48Z (A resets in 18.2h, B in ~73h).
const NOW = Date.parse("2026-09-28T18:48:00Z");

const q = (container, testid) =>
  container.querySelector(`[data-testid="${testid}"]`);

async function expand(container) {
  await act(async () => {
    q(container, "pace-toggle").dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
  });
}

function details(container) {
  return [...container.querySelectorAll('[data-testid="pace-detail"]')].map(
    (row) => [...row.children].map((cell) => cell.textContent).join(" = "),
  );
}

test("ok, collapsed: short headline, A/B bars with percent and tick, no details", async () => {
  const { container, root } = await render(pace({}));
  assert.equal(q(container, "pace-headline").textContent, "On pace");
  assert.equal(
    container.querySelectorAll('[data-testid="pace-bar"]').length,
    2,
  );
  const rowA = container.querySelector('[data-account="A"]');
  assert.equal(
    rowA.querySelector('[data-testid="pace-tick"]').style.left,
    "89.2%",
  );
  assert.equal(
    rowA.querySelector('[data-testid="pace-fill"]').style.width,
    "92%",
  );
  assert.equal(
    rowA.querySelector('[data-testid="pace-percent"]').textContent,
    "92%",
  );
  const rowB = container.querySelector('[data-account="B"]');
  assert.equal(
    rowB.querySelector('[data-testid="pace-percent"]').textContent,
    "6%",
  );
  assert.equal(q(container, "pace-details"), null, "collapsed hides details");
  assert.equal(q(container, "pace-hub-link"), null);
  assert.equal(
    q(container, "pace-toggle").getAttribute("aria-expanded"),
    "false",
  );
  await act(async () => root.unmount());
});

test("the strip is flat: no card border, no shadow", async () => {
  const { container, root } = await render(pace({}));
  const strip = q(container, "claude-pace-card");
  assert.equal(strip.tagName, "DIV", "the strip is no longer one big link");
  for (const cls of strip.classList) {
    assert.doesNotMatch(cls, /^(shadow|border)/, `unexpected ${cls}`);
  }
  await act(async () => root.unmount());
});

test("clicking expands the details and the hub link; clicking again collapses", async () => {
  const { container, root } = await render(pace({}));
  await expand(container);
  assert.equal(
    q(container, "pace-toggle").getAttribute("aria-expanded"),
    "true",
  );
  assert.deepEqual(details(container), [
    "A resets = in 18h",
    "B resets = in 3d",
    "Next reset = Tue 8 AM (A)",
    "Accounts left = ~1.0",
  ]);
  const link = q(container, "pace-hub-link");
  assert.equal(link.tagName, "A");
  assert.equal(
    link.getAttribute("href"),
    "https://pilot.tailb3d4b8.ts.net:6770",
  );
  assert.equal(link.getAttribute("target"), "_blank");
  await expand(container);
  assert.equal(q(container, "pace-details"), null);
  await act(async () => root.unmount());
});

test("per-account fill colour follows that account's status", async () => {
  const { container, root } = await render(
    pace({
      status: "warn",
      accounts: [
        account({ status: "warn", projectedAtReset: 1.03 }),
        account({
          id: "B",
          isDefault: false,
          usedFraction: 0.06,
          resetsAt: "2026-10-01T20:00:00Z",
          elapsedFraction: 0.42,
          status: "ok",
        }),
      ],
    }),
  );
  const fill = (id) =>
    container.querySelector(`[data-account="${id}"] [data-testid="pace-fill"]`);
  assert.ok(fill("A").classList.contains("bg-amber-500"), "warn A is amber");
  assert.ok(
    fill("B").classList.contains("bg-sidebar-active"),
    "ok B is accent",
  );
  assert.ok(!fill("B").classList.contains("bg-amber-500"));
  await act(async () => root.unmount());
});

test("a warn B is amber too: colour is not pinned to the letter", async () => {
  const { container, root } = await render(
    pace({
      status: "warn",
      accounts: [
        account({}),
        account({ id: "B", isDefault: false, status: "critical" }),
      ],
    }),
  );
  const fill = (id) =>
    container.querySelector(`[data-account="${id}"] [data-testid="pace-fill"]`);
  assert.ok(fill("A").classList.contains("bg-sidebar-active"));
  assert.ok(fill("B").classList.contains("bg-amber-500"));
  await act(async () => root.unmount());
});

test("warn: headline is the short 'runs out before reset', in the warn colour", async () => {
  const { container, root } = await render(
    pace({
      status: "warn",
      accounts: [account({ status: "warn", projectedAtReset: 1.03 })],
    }),
  );
  const headline = q(container, "pace-headline");
  assert.equal(headline.textContent, "A runs out before reset");
  assert.ok(headline.classList.contains("text-amber-600"));
  assert.ok(headline.classList.contains("dark:text-amber-400"));
  await act(async () => root.unmount());
});

test("critical keeps its own (red) headline colour", async () => {
  const { container, root } = await render(
    pace({
      status: "critical",
      accounts: [
        account({ status: "critical", usedFraction: 1, projectedAtReset: 1 }),
      ],
    }),
  );
  const headline = q(container, "pace-headline");
  assert.equal(headline.textContent, "A is out");
  assert.ok(headline.classList.contains("text-red-600"));
  await act(async () => root.unmount());
});

test("stale B reads unknown, never 0%", async () => {
  const { container, root } = await render(
    pace({
      headroomAccounts: 0.08,
      headroomPartial: true,
      accounts: [
        account({}),
        account({
          id: "B",
          isDefault: false,
          state: "stale",
          resetsAt: "2026-10-01T20:00:00Z",
          usedFraction: null,
          elapsedFraction: null,
          projectedAtReset: null,
          basis: null,
          status: "unknown",
        }),
      ],
    }),
  );
  const rowB = container.querySelector('[data-account="B"]');
  const percent = rowB.querySelector('[data-testid="pace-percent"]');
  assert.equal(percent.textContent, "?");
  assert.equal(percent.getAttribute("title"), "unknown (stale)");
  assert.doesNotMatch(rowB.textContent, /0%/);
  assert.equal(rowB.querySelector('[data-testid="pace-fill"]'), null);
  await expand(container);
  assert.deepEqual(details(container), [
    "A resets = in 18h",
    "B resets = unknown (stale) · in 3d",
    "Next reset = Tue 8 AM (A)",
    "Accounts left = ~0.1 +?",
  ]);
  await act(async () => root.unmount());
});

test("bad dates from the hub render the strip without throwing", async () => {
  const { container, root } = await render(
    pace({
      nextReset: { account: "A", resetsAt: "not-a-date" },
      accounts: [account({ resetsAt: "garbage" })],
    }),
  );
  assert.equal(q(container, "pace-headline").textContent, "On pace");
  assert.equal(
    container.querySelector('[data-account="A"] [data-testid="pace-percent"]')
      .textContent,
    "92%",
  );
  await expand(container);
  assert.deepEqual(details(container), [
    "A resets = unknown",
    "Accounts left = ~1.0",
  ]);
  await act(async () => root.unmount());
});

test("a failed refresh keeps the last payload, dimmed with 'as of'", async () => {
  const { container, root } = await render(pace({}));
  globalThis.__PACE_TEST_RESULT__ = null;
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  const strip = q(container, "claude-pace-card");
  assert.ok(strip, "strip still rendered after a failed refresh");
  assert.ok(strip.classList.contains("opacity-60"));
  await expand(container);
  const asOf = details(container).find((row) => row.startsWith("As of"));
  assert.match(asOf, /^As of = \d\d:\d\d$/);
  await act(async () => root.unmount());
});

test("fetch failure renders nothing", async () => {
  const { container, root } = await render(null);
  assert.equal(container.innerHTML, "");
  await act(async () => root.unmount());
});
