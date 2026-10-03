import { expect, type Locator, type Page } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { test } from "./helpers/agentBraveTest";
import { hexId, installMockRelay, mockEvent } from "./helpers/mockRelay";
import { shot } from "./helpers/shellPage";
import { signIn } from "./helpers/signIn";
import { routeUsageHub } from "./helpers/workFixture";

interface RowSeed {
  label: string;
  score?: number;
  ago: number;
  unread?: boolean;
  dm?: boolean;
}

// Activity, usage and alphabetical order deliberately disagree. The fifth
// visited row belongs AFTER the alphabetically earlier never-visited rows.
const CHANNELS: RowSeed[] = [
  { label: "alpha-old", score: 500, ago: 100, unread: true },
  { label: "zulu-new", score: 1, ago: 10, unread: true },
  { label: "Violet", score: 50, ago: 900 },
  { label: "tango", score: 40, ago: 800 },
  { label: "Sierra", score: 30, ago: 700 },
  { label: "romeo", score: 20, ago: 600 },
  { label: "zebra", score: 10, ago: 500 },
  { label: "aardvark", ago: 400 },
  { label: "Bravo", ago: 300 },
];

const DMS: RowSeed[] = [
  { label: "Unread Quinn", score: 1, ago: 1_000, unread: true },
  { label: "Vera", score: 50, ago: 900 },
  { label: "Uma", score: 40, ago: 800 },
  { label: "Theo", score: 30, ago: 700 },
  { label: "Sam", score: 20, ago: 600 },
  { label: "Zoe", score: 10, ago: 500 },
  { label: "aaron", ago: 400 },
  { label: "Bella", ago: 300 },
];

const FAVORITES: RowSeed[] = [
  { label: "urgent-favorite", score: 1, ago: 1_000, unread: true },
  { label: "Vera favorite", score: 50, ago: 900, dm: true },
  { label: "Tango favorite", score: 40, ago: 800 },
  { label: "Sierra favorite", score: 30, ago: 700 },
  { label: "Romeo favorite", score: 20, ago: 600, dm: true },
  { label: "zebra favorite", score: 10, ago: 500 },
  { label: "aardvark favorite", ago: 400 },
  { label: "Bravo favorite", ago: 300 },
];

async function seedSidebar(page: Page): Promise<string[]> {
  const viewerKey = generateSecretKey();
  const viewer = getPublicKey(viewerKey);
  const now = Date.now();
  const nowS = Math.floor(now / 1_000);
  const visits: Record<string, { score: number; at: number }> = {};
  const read: Record<string, number> = {};
  const favorites: Array<{ kind: "channel"; id: string; at: number }> = [];
  const events = [
    mockEvent({
      id: hexId(1),
      kind: 0,
      pubkey: viewer,
      content: JSON.stringify({ display_name: "Sidebar tester" }),
    }),
  ];
  let sequence = 2;
  for (const [sectionIndex, rows] of [CHANNELS, DMS, FAVORITES].entries()) {
    for (const [index, row] of rows.entries()) {
      const id = `${sectionIndex + 1}0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const peer = getPublicKey(generateSecretKey());
      const dm = sectionIndex === 1 || row.dm === true;
      events.push(
        mockEvent({
          id: hexId(sequence++),
          kind: 39000,
          created_at: nowS - 86_400,
          tags: [
            ["d", id],
            // Raw DM metadata sorts differently from the visible profile
            // labels. Using channel.name instead of dmDisplayName must fail.
            ["name", dm ? `raw-dm-${90 - index * 10}` : row.label],
            ["t", dm ? "dm" : "stream"],
            ...(dm
              ? [
                  ["p", viewer],
                  ["p", peer],
                ]
              : []),
          ],
        }),
        mockEvent({
          id: hexId(sequence++),
          kind: 0,
          pubkey: peer,
          content: JSON.stringify({
            name: `raw-peer-${90 - index * 10}`,
            display_name: row.label,
          }),
        }),
        mockEvent({
          id: hexId(sequence++),
          kind: 9,
          pubkey: peer,
          created_at: nowS - row.ago,
          tags: [["h", id]],
          content: `Activity in ${row.label}`,
        }),
      );
      read[id] = row.unread ? nowS - 3_600 : nowS;
      if (row.score !== undefined) visits[id] = { score: row.score, at: now };
      if (sectionIndex === 2) {
        // Pin order also disagrees with the expected ranking.
        favorites.unshift({ kind: "channel", id, at: now - index });
      }
    }
  }
  await page.addInitScript(
    ({ visits, read, favorites }) => {
      try {
        localStorage.setItem("buzz.sidebar-visits.v1", JSON.stringify(visits));
        localStorage.setItem("buzz.read-state.v1", JSON.stringify(read));
        localStorage.setItem(
          "buzz.channel-prefs.v1",
          JSON.stringify({ favorites, muted: [] }),
        );
        localStorage.setItem("buzz.collapsed-sections.v1", "[]");
        localStorage.setItem("buzz-theme", "buzz");
        localStorage.setItem("buzz-follow-system", "false");
      } catch {
        // Sandboxed frames have no localStorage.
      }
    },
    { visits, read, favorites },
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeUsageHub(page);
  await installMockRelay(page, events);
  // A non-conversation view avoids marking a fixture row seen or bumping
  // its visit score merely by mounting the app.
  await signIn(page, "/repos?view=inbox", viewerKey);
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await page.mouse.move(1_000, 100);
  return errors;
}

async function sectionRows(
  page: Page,
  label: string,
  screenshotName: string,
): Promise<Locator> {
  const section = page
    .getByTestId("channel-sidebar")
    .locator(`section[aria-label="${label}"]`);
  await expect(section).toBeVisible();
  await expect(section.getByTestId("section-more")).toBeVisible();
  await shot(page, `${screenshotName}-truncated`);
  await section.getByTestId("section-more").click();
  // Clicking "N more" leaves the pointer over the held list. Move it out
  // before reading order so pending activity/profile updates can re-rank.
  await page.mouse.move(1_000, 100);
  await expect(section.getByTestId("section-more")).toHaveText("Show less");
  await section.scrollIntoViewIfNeeded();
  await page.mouse.move(1_000, 100);
  await shot(page, `${screenshotName}-expanded`);
  return section.locator("ul > li > button[data-active] span.truncate");
}

// Local fallback is headed; CI retains its normal isolated browser.
test.use({
  viewport: { width: 1_440, height: 1_200 },
  headless: !!process.env.CI,
});

const consoleErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
});

test.describe("rendered sidebar order", () => {
  test.afterEach(async ({ page }, testInfo) => {
    await testInfo.attach("console-errors", {
      body: JSON.stringify(consoleErrors.get(page) ?? [], null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("sidebar-state", {
      body: JSON.stringify(
        await page.evaluate(() => ({
          visits: localStorage.getItem("buzz.sidebar-visits.v1"),
          read: localStorage.getItem("buzz.read-state.v1"),
          favorites: localStorage.getItem("buzz.channel-prefs.v1"),
          pointerOverList: document.querySelector("nav:hover") !== null,
          sections: Array.from(
            document.querySelectorAll(
              '[data-testid="channel-sidebar"] section',
            ),
            (section) => ({
              name: section.getAttribute("aria-label"),
              labels: Array.from(
                section.querySelectorAll(
                  "ul > li > button[data-active] span.truncate",
                ),
                (label) => label.textContent,
              ),
            }),
          ),
        })),
        null,
        2,
      ),
      contentType: "application/json",
    });
  });

  test("Channels: unread by recency, exactly four most used, then case-insensitive A-Z", async ({
    page,
  }) => {
    const errors = await seedSidebar(page);
    const rows = await sectionRows(page, "Channels", "channels");
    await expect(rows).toHaveText([
      "zulu-new",
      "alpha-old",
      "Violet",
      "tango",
      "Sierra",
      "romeo",
      "aardvark",
      "Bravo",
      "zebra",
    ]);
    expect(errors).toEqual([]);
  });

  test("Direct messages: unread, exactly four most used, then A-Z by displayed profile name", async ({
    page,
  }) => {
    const errors = await seedSidebar(page);
    const rows = await sectionRows(page, "Direct messages", "dms");
    await expect(rows).toHaveText([
      "Unread Quinn",
      "Vera",
      "Uma",
      "Theo",
      "Sam",
      "aaron",
      "Bella",
      "Zoe",
    ]);
    expect(errors).toEqual([]);
  });

  test("Favorites: mixed channels and DMs use unread, four most used, then A-Z", async ({
    page,
  }) => {
    const errors = await seedSidebar(page);
    const rows = await sectionRows(page, "Favorites", "favorites");
    await expect(rows).toHaveText([
      "urgent-favorite",
      "Vera favorite",
      "Tango favorite",
      "Sierra favorite",
      "Romeo favorite",
      "aardvark favorite",
      "Bravo favorite",
      "zebra favorite",
    ]);
    expect(errors).toEqual([]);
  });
});
