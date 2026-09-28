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

test("ok: headline, two bars, tick at week-elapsed, headroom, hub link", async () => {
  const { container, root } = await render(pace({}));
  assert.equal(
    container.querySelector('[data-testid="pace-headline"]').textContent,
    "On pace · next reset Tue 8 AM (A)",
  );
  const bars = container.querySelectorAll('[data-testid="pace-bar"]');
  assert.equal(bars.length, 2);
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
    container.querySelector('[data-testid="pace-secondary"]').textContent,
    "~1.0 accounts left",
  );
  const link = container.querySelector('[data-testid="claude-pace-card"]');
  assert.equal(link.tagName, "A");
  assert.equal(
    link.getAttribute("href"),
    "https://pilot.tailb3d4b8.ts.net:6770",
  );
  assert.equal(link.getAttribute("target"), "_blank");
  await act(async () => root.unmount());
});

test("stale B reads 'unknown', never 0%", async () => {
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
  assert.match(rowB.textContent, /unknown/);
  assert.equal(
    rowB.querySelector(".text-2xs").textContent,
    "B unknown (stale) · resets in 3d",
  );
  assert.doesNotMatch(rowB.textContent, /B 0%/);
  assert.equal(rowB.querySelector('[data-testid="pace-fill"]'), null);
  assert.equal(
    container.querySelector('[data-testid="pace-secondary"]').textContent,
    "~0.1 accounts left +?",
  );
  await act(async () => root.unmount());
});

test("warn: headline says who would run out, in the warn colour", async () => {
  const { container, root } = await render(
    pace({
      status: "warn",
      accounts: [account({ status: "warn", projectedAtReset: 1.03 })],
    }),
  );
  const headline = container.querySelector('[data-testid="pace-headline"]');
  assert.match(headline.textContent, /A would run out/);
  assert.ok(headline.classList.contains("text-amber-600"));
  await act(async () => root.unmount());
});

test("bad dates from the hub render the card without throwing", async () => {
  const { container, root } = await render(
    pace({
      nextReset: { account: "A", resetsAt: "not-a-date" },
      accounts: [account({ resetsAt: "garbage" })],
    }),
  );
  assert.equal(
    container.querySelector('[data-testid="pace-headline"]').textContent,
    "On pace",
  );
  assert.equal(
    container.querySelector('[data-account="A"] .text-2xs').textContent,
    "A 92%",
  );
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
  const card = container.querySelector('[data-testid="claude-pace-card"]');
  assert.ok(card, "card still rendered after a failed refresh");
  assert.ok(card.classList.contains("opacity-60"));
  assert.match(
    container.querySelector('[data-testid="pace-secondary"]').textContent,
    /^~1\.0 accounts left · as of \d\d:\d\d$/,
  );
  await act(async () => root.unmount());
});

test("fetch failure renders nothing", async () => {
  const { container, root } = await render(null);
  assert.equal(container.innerHTML, "");
  await act(async () => root.unmount());
});
