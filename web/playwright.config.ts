import { defineConfig, devices } from "@playwright/test";

/**
 * Preview port, overridable with `PLAYWRIGHT_PORT`.
 *
 * `reuseExistingServer` is on outside CI, and it does not check WHOSE server is
 * already listening — it only checks that something answers on the port. When
 * two worktrees run the suite at once, the second silently tests the FIRST
 * one's build: every assertion runs against someone else's code, and the run
 * looks completely normal apart from inexplicable failures. That happened on
 * 2026-09-04 between two agent worktrees.
 *
 * Set `PLAYWRIGHT_PORT` to a port of your own when running alongside another
 * checkout. The default is unchanged, so CI and single-checkout runs behave
 * exactly as before.
 */
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: [
        "**/smoke.spec.ts",
        "**/shell-views.spec.ts",
        "**/settings.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: ".",
    reuseExistingServer: !process.env.CI,
    url: BASE_URL,
  },
});
