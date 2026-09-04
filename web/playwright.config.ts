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
        "**/parity-surfaces.spec.ts",
        "**/forum.spec.ts",
        "**/moderation-queue.spec.ts",
        "**/sidebar-appearance.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    /**
     * Huddle: needs a running relay AND a microphone.
     *
     * The in-call controls only exist once the audio room has admitted the
     * viewer, so this project grants the mic permission up front and hands
     * Chromium a fake capture device — a real grant prompt is not something
     * an automated run can answer, and skipping the join would test nothing.
     * The spec skips itself when `E2E_RELAY_WS` is unset.
     */
    {
      name: "huddle",
      testMatch: ["**/huddle.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
          ],
        },
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
