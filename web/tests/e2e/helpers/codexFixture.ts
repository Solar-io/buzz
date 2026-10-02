import type { Page } from "@playwright/test";
import type { CodexVitals } from "../../../src/features/vitals/lib/codexUsage";

/** The hub contract, including the real zero weekly reading. */
export function codexFixture(nowMs = Date.now()): CodexVitals {
  const window = {
    usedFraction: 0,
    resetsAt: "2026-10-09T21:13:06Z",
    windowMinutes: 10080,
    capturedAt: new Date(nowMs).toISOString(),
    stale: false,
    source: "codex-rollout",
  };
  return {
    v: 1,
    computedAt: new Date(nowMs).toISOString(),
    planLabel: "ChatGPT Pro (Codex)",
    planType: "pro",
    weekly: window,
    short: { ...window, usedFraction: 0.25, windowMinutes: 300 },
    credits: { balance: 12345, unlimited: false, capturedAt: null },
    usage: {
      today: {
        direct: {
          calls: 12,
          totalInput: 12000,
          output: 3400,
          listCost: 0.15,
          incomplete: false,
        },
        routed: {
          calls: 34,
          totalInput: 34000,
          output: 5600,
          listCost: null,
          incomplete: true,
        },
      },
      last7d: {
        direct: {
          calls: 859,
          totalInput: 1200000,
          output: 34000,
          listCost: 7.15,
          incomplete: false,
        },
        routed: {
          calls: 6724,
          totalInput: 2400000,
          output: 56000,
          listCost: 13.23,
          incomplete: true,
        },
      },
    },
  };
}

/** Serve /v1/codex at the same HTTP boundary as the pace and runway mocks. */
export async function routeCodexUsage(
  page: Page,
  data = codexFixture(),
  status = 200,
): Promise<void> {
  await page.route("**/v1/codex", (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(status === 200 ? data : { error: "unavailable" }),
    }),
  );
}
