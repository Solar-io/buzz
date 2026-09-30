import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";
import * as nip44 from "nostr-tools/nip44";

import {
  hexId,
  installMockRelay,
  type MockRelay,
  type MockRelayOptions,
  mockEvent,
} from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";
import {
  buildWorkFixture,
  routeUsageHub,
  type WorkFixture,
} from "./helpers/workFixture";

/**
 * The redesign's shell (web redesign Phase 1), driven through the real
 * sign-in against a relay faked at the WebSocket boundary.
 *
 * Reachability is what this proves and no unit test can: the Work rail is
 * fed by seven event families through three providers, and a pane that is
 * correct but never mounted — or a decrypt path that silently yields nothing
 * — looks exactly like a working one in every `.test.mjs`. Here the rows have
 * to appear on screen from real (mocked-relay) events, three families of
 * them NIP-44 ciphertext.
 *
 * Set `SHOTS_DIR` to also write the artboard screenshots (Main / PhoneWork /
 * PhoneChannel / Vitals / Toasts, both themes) the phase's visual check
 * compares against docs/plans/2026-09-29-web-redesign/*.dc.html. The toast
 * stack case only runs then: it has to wait out the reminder check interval.
 */

const SHOTS_DIR = process.env.SHOTS_DIR;
const REFUSAL = "invalid: root tag does not match thread ancestry";

async function shot(
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

async function open(
  page: Page,
  options: {
    theme: string;
    path: (fixture: WorkFixture) => string;
    fixture?: Parameters<typeof buildWorkFixture>[0];
    relay?: MockRelayOptions;
  },
): Promise<{ fixture: WorkFixture; relay: MockRelay }> {
  const fixture = buildWorkFixture(options.fixture);
  await page.addInitScript((theme) => {
    localStorage.setItem("buzz-theme", theme);
    localStorage.setItem("buzz-follow-system", "false");
  }, options.theme);
  await routeUsageHub(page);
  const relay = await installMockRelay(page, fixture.events, options.relay);
  await signIn(page, options.path(fixture), fixture.viewerKey);
  return { fixture, relay };
}

const channelPath = (fixture: WorkFixture) =>
  `/repos?c=${fixture.channels["flight-path"]}`;

async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = page
    .locator('[data-custom-content-pane="chat"] textarea')
    .last();
  await composer.fill(text);
  await composer.press("Enter");
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`desktop 1440 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 960 } });

    test("the Work rail docks beside the channel with every section fed", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await open(page, { theme, path: channelPath });

      const rail = page.getByTestId("work-rail");
      await expect(rail).toBeVisible();
      // The fixed palette is on: the attribute is set and the engine's
      // inline vars are gone (L8: no stale derived colours).
      await expect(page.locator("html")).toHaveAttribute(
        "data-palette",
        theme === "buzz" ? "buzz-light" : "buzz-dark",
      );
      expect(
        await page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--background"),
        ),
      ).toBe("");

      // Needs you: two asks, a mention, two approvals (the granted one is
      // gone), three reminders.
      await expect(
        rail.getByText("Beat 03 hold: 1.5s or keep 2s?"),
      ).toBeVisible();
      await expect(
        rail.getByText("Merge fix(web): clamp jitter calibration"),
      ).toBeVisible();
      await expect(rail.getByText("already decided")).toHaveCount(0);
      await expect(rail.getByRole("button", { name: /^All 8$/ })).toBeVisible();
      // A self-encrypted reminder decrypted and reads as overdue.
      await expect(rail.getByText("6d overdue")).toBeVisible();

      // Running: four live turns from decrypted observer frames, and the
      // silent one still listed as stalled.
      await expect(rail.getByTestId("run-row-live")).toHaveCount(4);
      await expect(rail.getByTestId("run-row-stalled")).toHaveCount(1);
      await expect(rail.getByText(/no heartbeat/)).toBeVisible();

      // Queued and Done fold to summaries with real counts.
      await expect(
        rail.getByRole("button", { name: /Queued\s*2/ }),
      ).toBeVisible();
      await expect(
        rail.getByRole("button", { name: /Done today\s*3/ }),
      ).toBeVisible();

      // Sidebar: the nav that exists today, and Vitals from the hub.
      const sidebar = page.getByTestId("app-shell-sidebar");
      await expect(
        sidebar.getByRole("button", { name: "Files" }),
      ).toBeVisible();
      await expect(
        sidebar.getByRole("button", { name: "Reminders" }),
      ).toHaveCount(0);
      await expect(sidebar.getByTestId("vitals-block")).toContainText(
        "45% free",
      );
      expect(pageErrors).toEqual([]);
      await shot(page, `main-${theme}-1440`);

      // The rail stays beside full-page views too (Work is always tab 1).
      await page.goto(`/repos?view=workflows`);
      await expect(page.getByTestId("workflows-page")).toBeVisible();
      await expect(rail).toBeVisible();
      await page.goBack();
      await expect(rail.getByTestId("run-row-live")).toHaveCount(4);

      // Vitals popover.
      await sidebar.getByTestId("vitals-block").click();
      await expect(page.getByTestId("vitals-popover")).toContainText(
        "B is running at 1.6× its pace",
      );
      await shot(page, `vitals-${theme}-1440`);
      await page.keyboard.press("Escape");
    });

    test("a thread opens as a tab beside Work and closes back to it", async ({
      page,
    }) => {
      await open(page, { theme, path: channelPath });
      const host = page.getByTestId("right-pane-host");
      await expect(host).toHaveAttribute("data-active-tab", "work");
      // One tab: no strip, just the Work title.
      await expect(page.getByTestId("right-pane-tabs")).toHaveCount(0);

      await page.getByRole("button", { name: /View all 3 replies/ }).click();
      await expect(host).toHaveAttribute("data-active-tab", "thread");
      const tabs = page.getByTestId("right-pane-tabs");
      await expect(tabs.getByRole("tab")).toHaveText([/Work/, "Thread"]);
      await expect(page.getByTestId("thread-panel")).toBeVisible();
      await expect(page.getByTestId("work-rail")).toHaveCount(0);
      await shot(page, `thread-tab-${theme}-1440`);

      // Work is one click away, and the thread stays mounted behind it.
      await tabs.getByRole("tab", { name: /Work/ }).click();
      await expect(page.getByTestId("work-rail")).toBeVisible();
      await expect(page.getByTestId("thread-panel")).toBeHidden();

      // Closing the thread tab returns to Work and drops the strip.
      await tabs.getByRole("tab", { name: "Thread" }).click();
      await tabs.getByRole("button", { name: "Close Thread" }).click();
      await expect(host).toHaveAttribute("data-active-tab", "work");
      await expect(page.getByTestId("right-pane-tabs")).toHaveCount(0);

      // Folding the rail leaves the 44 px strip with the live counts.
      await page.getByRole("button", { name: "Collapse Work" }).click();
      const strip = page.getByTestId("work-rail-collapsed");
      await expect(strip).toBeVisible();
      await expect(
        strip.getByRole("button", { name: "8 need you" }),
      ).toBeVisible();
      await strip.getByRole("button", { name: "Expand Work" }).click();
      await expect(page.getByTestId("work-rail")).toBeVisible();
    });

    test("a refused send raises a sticky toast with the relay's text verbatim", async ({
      page,
    }) => {
      await open(page, {
        theme,
        path: channelPath,
        relay: {
          rejectPublish: (event) =>
            event.kind === 9 && event.content.includes("[refuse]")
              ? REFUSAL
              : null,
        },
      });
      await expect(page.getByTestId("work-rail")).toBeVisible();
      await sendMessage(page, "reply to a reply [refuse]");
      const toast = page.getByTestId("buzz-toast-sendError");
      await expect(toast).toBeVisible();
      await expect(toast).toContainText("Message not sent");
      await expect(toast).toContainText(REFUSAL);
      await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(
        toast.getByRole("button", { name: "Copy error" }),
      ).toBeVisible();
      // Sticky: still there well past the 6 s the self-dismissing toasts get.
      await page.waitForTimeout(7_000);
      await expect(toast).toBeVisible();
    });

    test("toast stack: the five variants", async ({ page }) => {
      test.skip(!SHOTS_DIR, "visual run only (waits out the reminder check)");
      test.setTimeout(120_000);
      const { fixture, relay } = await open(page, {
        theme,
        path: channelPath,
        fixture: { dueInS: 50 },
        relay: {
          rejectPublish: (event) =>
            event.kind === 9 && event.content.includes("[refuse]")
              ? REFUSAL
              : null,
        },
      });
      const now = () => Math.floor(Date.now() / 1000);
      await expect(page.getByTestId("work-rail")).toBeVisible();
      // Needs-you toasts stay quiet while Work is on screen: fold the rail.
      await page.getByRole("button", { name: "Collapse Work" }).click();
      // The button sits under the toaster; a pointer resting there hovers the
      // stack, which pauses every toast's timer for good.
      await page.mouse.move(700, 480);
      // A send of mine that an agent will pick up (accepted by the relay).
      await sendMessage(page, "Run the jitter buffer QA again, please.");
      await expect.poll(() => relay.published.length).toBeGreaterThan(0);
      const mine = relay.published.find((event) => event.kind === 9);
      // Let the feed settle (10 s) so a new approval reads as an arrival, and
      // the transient toasts clear.
      await page.waitForTimeout(11_000);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
        timeout: 12_000,
      });

      // 1 — agent done: the turn my send started completes (owner-encrypted
      // frames). It fires for a channel I am not looking at, so step away.
      await page
        .getByTestId("app-shell-sidebar")
        .locator("button", { hasText: "design" })
        .first()
        .click();
      const nikon = fixture.agents.nikon;
      const frame = (kind: string, payload: unknown, seq: number) =>
        mockEvent({
          id: hexId(70_000 + seq, "d"),
          kind: 24200,
          pubkey: nikon.pubkey,
          created_at: now(),
          tags: [
            ["p", fixture.viewer],
            ["agent", nikon.pubkey],
          ],
          content: nip44.v2.encrypt(
            JSON.stringify({
              seq,
              timestamp: new Date().toISOString(),
              kind,
              agentIndex: 0,
              channelId: fixture.channels["flight-path"],
              sessionId: "s-done",
              turnId: "t-done",
              startedAt: new Date().toISOString(),
              payload,
            }),
            nip44.v2.utils.getConversationKey(nikon.secretKey, fixture.viewer),
          ),
        });
      relay.push(
        frame("turn_started", { triggeringEventIds: [mine?.id ?? ""] }, 1),
      );
      relay.push(frame("turn_completed", { stopReason: "end_turn" }, 2));
      await expect(page.getByTestId("buzz-toast-agentDone")).toBeVisible();

      // 2 — message: a DM arrives.
      relay.push(
        mockEvent({
          id: hexId(70_010, "d"),
          kind: 9,
          pubkey: fixture.agents.gilfoyle.pubkey,
          created_at: now(),
          tags: [["h", fixture.channels["dm-gilfoyle"]]],
          content: "Unblinded, and it's an upset: Sol max won the game build.",
        }),
      );
      await expect(page.getByTestId("buzz-toast-message")).toBeVisible();

      // 3 — needs you: a workflow approval addressed to me arrives.
      const approval = (n: number, text: string) =>
        mockEvent({
          id: hexId(70_020 + n, "d"),
          kind: 46010,
          pubkey: "ee".repeat(32),
          created_at: now(),
          tags: [
            ["d", `wf-${n}`],
            ["h", fixture.channels.engineering],
            ["run", `run-9${n}`],
            ["approval", `d${n}`.repeat(32)],
            ["p", fixture.viewer],
          ],
          content: text,
        });
      relay.push(approval(4, "release: approve the production deploy"));
      await expect(page.getByTestId("buzz-toast-needsYou")).toBeVisible();
      await shot(page, `toasts-a-${theme}-1440`, { keepToasts: true });

      // 4 — send error: the relay refuses a message.
      await sendMessage(page, "reply to a reply [refuse]");
      await expect(page.getByTestId("buzz-toast-sendError")).toBeVisible();

      // 5 — feedback due: the reminder seeded 50 s out crosses its time and
      // the 30 s check raises it.
      await expect(page.getByTestId("buzz-toast-feedbackDue")).toBeVisible({
        timeout: 70_000,
      });
      // The two self-dismissing toasts have run out; the three that need a
      // decision are all still up.
      await expect(page.getByTestId("buzz-toast-agentDone")).toHaveCount(0);
      await expect(page.getByTestId("buzz-toast-needsYou")).toBeVisible();
      await expect(page.getByTestId("buzz-toast-sendError")).toBeVisible();
      await shot(page, `toasts-b-${theme}-1440`, { keepToasts: true });

      // Past three, the rest wait behind "N more · Clear all".
      relay.push(approval(5, "nightly-backup: approve the restore drill"));
      relay.push(approval(6, "deploy-dev: approve the schema migration"));
      await expect(page.getByTestId("toast-stack-header")).toContainText(
        "2 more",
      );
      await shot(page, `toasts-c-${theme}-1440`, { keepToasts: true });
      await page.getByTestId("toast-stack-header").getByRole("button").click();
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    });
  });

  test.describe(`phone 390 · ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("a bare /repos lands on Work with the tab bar", async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await open(page, { theme, path: () => "/repos" });

      await expect(page).toHaveURL(/view=work/);
      const work = page.getByTestId("work-page");
      await expect(work).toBeVisible();
      await expect(work.getByRole("heading", { name: "Work" })).toBeVisible();
      await expect(
        work.getByRole("button", { name: /^Needs you 8$/ }),
      ).toBeVisible();
      await expect(work.getByTestId("vitals-strip")).toContainText("45% free");
      const tabs = page.getByTestId("phone-tab-bar");
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole("button", { name: /Work/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(pageErrors).toEqual([]);
      await shot(page, `phone-work-${theme}-390`);

      // Channels tab: the channel list as a page.
      await tabs.getByRole("button", { name: /Channels/ }).click();
      await expect(page).toHaveURL(/view=channels/);
      const row = page
        .getByTestId("channel-sidebar")
        .locator("button", { hasText: "flight-path" })
        .last();
      await expect(row).toBeVisible();
      await shot(page, `phone-channels-${theme}-390`);

      // Opening a conversation hides the bar and shows the back chevron.
      await row.click();
      await expect(tabs).toBeHidden();
      await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
      await expect(page.getByText("Three beats. Beat 01")).toBeVisible();
      await shot(page, `phone-channel-${theme}-390`);

      // Back returns to the tab it was opened from.
      await page.getByRole("button", { name: "Back" }).click();
      await expect(page).toHaveURL(/view=channels/);
      await expect(tabs).toBeVisible();

      // More is a sheet of the views that exist today.
      await tabs.getByRole("button", { name: "More" }).click();
      const more = page.getByTestId("phone-more-sheet");
      await expect(
        more.getByRole("button", { name: "Reminders" }),
      ).toBeVisible();
      await more.getByRole("button", { name: "Inbox" }).click();
      await expect(page).toHaveURL(/view=inbox/);
      await expect(tabs.getByRole("button", { name: "More" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  });
}

test.describe("tablet 900 · buzz", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("between md and lg, Work is a sidebar row and a page", async ({
    page,
  }) => {
    await open(page, { theme: "buzz", path: channelPath });
    // No docked rail below lg, and no phone tab bar at md and up.
    await expect(page.getByTestId("work-rail")).toBeHidden();
    await expect(page.getByTestId("phone-tab-bar")).toHaveCount(0);
    const work = page
      .getByTestId("app-shell-sidebar")
      .locator("button", { hasText: "Work" });
    await expect(work).toBeVisible();
    await expect(work).toContainText("8");
    await work.click();
    await expect(page).toHaveURL(/view=work/);
    await expect(page.getByTestId("work-page")).toBeVisible();
    await shot(page, "tablet-work-buzz-900");
  });
});

test.describe("desktop 1440 · catppuccin-mocha", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("the Work rail reads on a derived theme", async ({ page }) => {
    await open(page, { theme: "catppuccin-mocha", path: channelPath });
    await expect(page.getByTestId("work-rail")).toBeVisible();
    // A Shiki theme stays derived: no fixed palette, engine vars inline.
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-palette",
      /.+/,
    );
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--background"),
      ),
    ).not.toBe("");
    await expect(
      page.getByTestId("work-rail").getByTestId("run-row-live"),
    ).toHaveCount(4);
    await shot(page, "main-catppuccin-mocha-1440");
  });
});
