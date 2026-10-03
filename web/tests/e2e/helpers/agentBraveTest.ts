import { test as base } from "@playwright/test";

/** Use Agent Brave for local runs; CI keeps its standard isolated browser. */
export const test = process.env.BUZZ_E2E_CDP
  ? base.extend({
      browser: async ({ playwright }, use) => {
        // The runner closes its own contexts; the shared browser stays alive.
        await use(
          await playwright.chromium.connectOverCDP(
            process.env.BUZZ_E2E_CDP as string,
          ),
        );
      },
    })
  : base;
