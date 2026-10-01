import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

import {
  installMockRelay,
  type MockEvent,
  type MockRelay,
  type MockRelayOptions,
} from "./mockRelay";
import { signIn } from "./signIn";
import {
  buildWorkFixture,
  routeUsageHub,
  type WorkFixture,
} from "./workFixture";

/**
 * Shared driving for the redesign specs (`work-shell`, `messages`): sign in
 * against the mocked relay with a fixture, and write artboard screenshots
 * when `SHOTS_DIR` is set.
 */

export const SHOTS_DIR = process.env.SHOTS_DIR;

export async function shot(
  page: Page,
  name: string,
  options: { keepToasts?: boolean } = {},
): Promise<void> {
  if (!SHOTS_DIR) {
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  if (!options.keepToasts) {
    // The sign-in toast (and any arrival toast the mock's replay raises)
    // would sit over the top-right of every frame: let them run out first.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
      timeout: 12_000,
    });
  }
  // A pointer left over the last click would hover a row and put its action
  // bar in the frame: park it in the corner.
  await page.mouse.move(1, 1);
  // Let entrance animations settle so two themes capture the same frame.
  // Only FINITE ones: the running hexes pulse forever and never finish.
  await page
    .evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      ),
    )
    .catch(() => {});
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

export async function openShell(
  page: Page,
  options: {
    theme: string;
    path: (fixture: WorkFixture) => string;
    fixture?: Parameters<typeof buildWorkFixture>[0];
    relay?: MockRelayOptions;
    /** More events to serve from the first REQ on, built on the fixture. */
    extra?: (fixture: WorkFixture) => MockEvent[];
  },
): Promise<{ fixture: WorkFixture; relay: MockRelay }> {
  const fixture = buildWorkFixture(options.fixture);
  await page.addInitScript((theme) => {
    // Init scripts run in EVERY frame, including a sandboxed file preview
    // (opaque origin), where touching localStorage throws — that would be
    // the harness's error, not the app's.
    try {
      localStorage.setItem("buzz-theme", theme);
      localStorage.setItem("buzz-follow-system", "false");
    } catch {
      // A sandboxed frame: nothing to seed.
    }
  }, options.theme);
  await routeUsageHub(page);
  const relay = await installMockRelay(
    page,
    [...fixture.events, ...(options.extra?.(fixture) ?? [])],
    options.relay,
  );
  await signIn(page, options.path(fixture), fixture.viewerKey);
  return { fixture, relay };
}

export const channelPath =
  (key = "flight-path") =>
  (fixture: WorkFixture) =>
    `/repos?c=${fixture.channels[key]}`;

/** The conversation's main composer (the last chat textarea on the page). */
export function mainComposer(page: Page) {
  return page.locator('[data-custom-content-pane="chat"] textarea').last();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = mainComposer(page);
  await composer.fill(text);
  await composer.press("Enter");
}
