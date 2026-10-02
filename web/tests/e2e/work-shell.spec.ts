import { expect, test } from "@playwright/test";
import * as nip44 from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";

import { hexId, mockEvent } from "./helpers/mockRelay";
import { buildWorkFixture } from "./helpers/workFixture";
import {
  channelPath as shellChannelPath,
  openShell as open,
  SHOTS_DIR,
  sendMessage,
  shot,
} from "./helpers/shellPage";

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

const REFUSAL = "invalid: root tag does not match thread ancestry";
const channelPath = shellChannelPath();

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
      // The runway's 72 h calendar projection: B runs dry before its reset,
      // A lasts (fixture in workFixture.routeUsageHub).
      await expect(sidebar.getByTestId("vitals-block")).toContainText("B dry");
      await expect(page.getByTestId("vitals-outlook")).toContainText(
        "Account B runs dry around",
      );
      await expect(page.getByTestId("vitals-popover")).toContainText(
        "A won't run dry — about 64% used when it resets",
      );
      await expect(page.getByTestId("vitals-runway-method")).toContainText(
        "72h average, carried forward to each reset: A 1.2%/h · B 20%/h (B: 40h of history)",
      );
      // Calendar days, not active hours: no active-hour wording survives
      // (19b6f81db). The word "active" itself now belongs to the pool
      // default's marker (4a53813fc), so the guard is on the phrasing.
      await expect(page.getByTestId("vitals-popover")).not.toContainText(
        /active[ -](use|hours?|h\b)/i,
      );
      // A is the fixture's pool default: its row, and only its row, says so.
      await expect(page.getByTestId("vitals-account-active")).toHaveCount(1);
      await expect(
        page
          .getByTestId("vitals-account-A")
          .getByTestId("vitals-account-active"),
      ).toBeVisible();
      await shot(page, `vitals-${theme}-1440`);
      await page.keyboard.press("Escape");
    });

    test("a thread is open inline under its message by default; the strip stays Work | Canvas", async ({
      page,
    }) => {
      const { fixture, relay } = await open(page, { theme, path: channelPath });
      const host = page.getByTestId("right-pane-host");
      await expect(host).toHaveAttribute("data-active-tab", "work");
      // Exactly two top-level tabs (Sam, 2026-09-30) — a thread never adds one.
      const paneTabs = page.getByTestId("right-pane-tabs");
      await expect(paneTabs.getByRole("tab")).toHaveCount(2);
      await expect(page.getByTestId("right-pane-tab-work")).toHaveAttribute(
        "aria-selected",
        "true",
      );

      const ask = fixture.events.find((event) =>
        event.content.startsWith("@Gilfoyle turn the handoff notes"),
      );
      expect(ask).toBeTruthy();
      const chip = page.getByTestId(`thread-chip-${ask?.id}`);
      await expect(chip).toHaveText(/3 replies/);
      // Open without a click (Sam, 2026-09-30): the replies and the reply
      // box are already there.
      const thread = page.getByTestId(`inline-thread-${ask?.id}`);
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await expect(thread).toContainText("Beat 01 is captured. Two to go.");
      await expect(thread.getByTestId("thread-reply-box")).toBeVisible();
      // The viewer can still fold it — and open it again.
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(thread.getByTestId("thread-reply-box")).toHaveCount(0);
      await expect(thread).not.toContainText("Beat 01 is captured.");
      await chip.click();
      await expect(thread.getByTestId("thread-reply-box")).toBeVisible();
      // It reopens DOWNWARD, from where it was clicked: the chip and the
      // first reply stay on screen (a list re-pin once pushed them off).
      await page.waitForTimeout(800);
      await expect(chip).toBeInViewport();
      await expect(thread.getByText("On it — splitting")).toBeInViewport();
      await expect(paneTabs.getByRole("tab")).toHaveCount(2);
      await expect(page.getByTestId("work-rail")).toBeVisible();
      await shot(page, `thread-inline-${theme}-1440`);

      // A reply from the inline box is rooted at the ask (NIP-10 thread
      // ancestry — the relay refuses anything else).
      const box = thread.getByTestId("thread-reply-box").locator("textarea");
      await box.fill("Ship beat 02 next.");
      await box.press("Enter");
      await expect
        .poll(() =>
          relay.published.find(
            (event) =>
              event.kind === 9 && event.content === "Ship beat 02 next.",
          ),
        )
        .toBeTruthy();
      const reply = relay.published.find(
        (event) => event.content === "Ship beat 02 next.",
      );
      expect(reply?.tags).toContainEqual(["e", ask?.id, "", "reply"]);

      // Folding the rail leaves the 44 px strip with the live counts.
      await page.getByRole("button", { name: "Collapse Work" }).click();
      const strip = page.getByTestId("work-rail-collapsed");
      await expect(strip).toBeVisible();
      await expect(
        strip.getByRole("button", { name: "8 need you" }),
      ).toBeVisible();
      await strip.getByRole("button", { name: "Expand Work" }).click();
      await expect(page.getByTestId("work-rail")).toBeVisible();

      // The fold still reaches the pane's other tab: Canvas (empty here).
      await page.getByRole("button", { name: "Collapse Work" }).click();
      await strip.getByRole("button", { name: "Open Canvas" }).click();
      await expect(page.getByTestId("canvas-empty")).toBeVisible();
      await expect(page.getByTestId("right-pane-tab-canvas")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.getByTestId("right-pane-tab-work").click();
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

    test("a bare /repos lands on Channels with the tab bar", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await open(page, { theme, path: () => "/repos" });

      // The phone opens on the Channels tab (Sam, 2026-10-01; was Work).
      await expect(page).toHaveURL(/view=channels/);
      const tabs = page.getByTestId("phone-tab-bar");
      await expect(tabs).toBeVisible();
      await expect(
        tabs.getByRole("button", { name: /Channels/ }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        page
          .getByTestId("channel-sidebar")
          .locator("button", { hasText: "flight-path" })
          .last(),
      ).toBeVisible();

      await tabs.getByRole("button", { name: /Work/ }).click();
      await expect(page).toHaveURL(/view=work/);
      const work = page.getByTestId("work-page");
      await expect(work).toBeVisible();
      await expect(work.getByRole("heading", { name: "Work" })).toBeVisible();
      await expect(
        work.getByRole("button", { name: /^Needs you 8$/ }),
      ).toBeVisible();
      await expect(work.getByTestId("vitals-strip")).toContainText("45% free");
      // Channels on the left, Work in the middle (Sam, 2026-10-01) — and
      // Work's needs-you badge moved with it.
      await expect(tabs.getByRole("button")).toHaveText([
        /^Channels/,
        /^Work8$/,
        /^More$/,
      ]);
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
      await expect(
        page.getByRole("button", { name: "Back", exact: true }),
      ).toBeVisible();
      // In the TIMELINE: the mock's replay also raises a message toast with
      // the same text, and an unscoped match is then two elements.
      await expect(
        page
          .locator(".buzz-timeline-scrollbar")
          .getByText("Three beats. Beat 01"),
      ).toBeVisible();
      await shot(page, `phone-channel-${theme}-390`);

      // Back returns to the tab it was opened from.
      await page.getByRole("button", { name: "Back", exact: true }).click();
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

    test("the Channels page is the desktop rail: Favorites, Forums, Links, Vitals with its runway", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      // Favorites live in THIS device's localStorage (channelPrefs.ts):
      // seed a channel and a DM the way a phone that favorited them would.
      const ids = buildWorkFixture().channels;
      await page.addInitScript(
        (favorites) => {
          try {
            localStorage.setItem(
              "buzz.channel-prefs.v1",
              JSON.stringify({ favorites, muted: [] }),
            );
          } catch {
            // A sandboxed frame: nothing to seed.
          }
        },
        [
          { kind: "channel", id: ids.design },
          { kind: "channel", id: ids["dm-gilfoyle"] },
        ],
      );
      await open(page, {
        theme,
        path: () => "/repos?view=channels",
        extra: (fixture) => [
          mockEvent({
            id: hexId(901, "f"),
            kind: 39000,
            created_at: Math.floor(Date.now() / 1000) - 86_400,
            tags: [
              ["d", FORUM_ID],
              ["name", "release-notes"],
              ["t", "forum"],
            ],
          }),
          linksBlob(fixture.viewerKey, [
            {
              id: "sc:1",
              label: "Grafana",
              url: "https://grafana.example/",
              mode: "window",
            },
          ]),
        ],
      });

      // The page's own rail, not the md+ aside that is in the DOM but hidden.
      const rail = page
        .getByTestId("channel-sidebar")
        .filter({ visible: true });
      await expect(rail).toBeVisible();
      const tabs = page.getByTestId("phone-tab-bar");
      await expect(
        tabs.getByRole("button", { name: /Channels/ }),
      ).toHaveAttribute("aria-current", "page");

      // Forums and Links: folded nav rows with their counts, as on desktop.
      const navRow = (label: string) =>
        rail
          .getByTestId("sidebar-nav-disclosure")
          .getByRole("button", { name: new RegExp(`^${label}`) });
      await expect(navRow("Forums")).toBeVisible();
      await expect(navRow("Forums")).toHaveAttribute("aria-expanded", "false");
      await expect(
        navRow("Forums").getByTestId("nav-disclosure-count"),
      ).toHaveText("1");
      await expect(
        navRow("Links").getByTestId("nav-disclosure-count"),
      ).toHaveText("1");

      // Favorites: a channel and a DM, above Channels, which no longer
      // lists the favorited channel.
      const favorites = rail.locator('section[aria-label="Favorites"]');
      const channels = rail.locator('section[aria-label="Channels"]');
      await expect(favorites).toBeVisible();
      await expect(favorites).toContainText("design");
      await expect(favorites).toContainText("Gilfoyle");
      await expect(
        channels.locator("button", { hasText: /^design$/ }),
      ).toHaveCount(0);
      const above = await rail.evaluate((root) => {
        const fav = root.querySelector('section[aria-label="Favorites"]');
        const chan = root.querySelector('section[aria-label="Channels"]');
        return Boolean(
          fav &&
            chan &&
            fav.compareDocumentPosition(chan) &
              Node.DOCUMENT_POSITION_FOLLOWING,
        );
      });
      expect(above).toBe(true);

      // Vitals at the foot: usage AND the runway clause, nothing crichton
      // (no hatch in this build) — and no empty section standing in for it.
      const vitals = rail.getByTestId("vitals-block");
      await expect(vitals).toBeVisible();
      await expect(vitals).toContainText("45% free");
      await expect(vitals).toContainText("B dry");
      await expect(rail.getByTestId("vitals-crichton")).toHaveCount(0);
      // No profile row: Settings opens from the B, as on desktop.
      await expect(rail.locator("footer")).not.toContainText("Connected");
      expect(pageErrors).toEqual([]);
      await shot(page, `phone-rail-${theme}-390`);

      await rail.getByRole("button", { name: /Buzz menu/ }).click();
      await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
    });
  });
}

const FORUM_ID = "30000000-0000-4000-8000-000000000001";

/** The viewer's Links blob: kind 30078 `d=shortcut-bar`, sealed to self. */
function linksBlob(secretKey: Uint8Array, shortcuts: unknown[]) {
  const pubkey = getPublicKey(secretKey);
  return mockEvent({
    id: hexId(902, "f"),
    pubkey,
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000) - 3_600,
    tags: [
      ["d", "shortcut-bar"],
      ["t", "shortcut-bar"],
    ],
    content: nip44.v2.encrypt(
      JSON.stringify({ v: 1, shortcuts: { __sidebar__: shortcuts } }),
      nip44.v2.utils.getConversationKey(secretKey, pubkey),
    ),
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
