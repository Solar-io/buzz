import { chromium, expect, test as base } from "@playwright/test";
import {
  channelPath,
  mainComposer,
  openShell,
  shot,
} from "./helpers/shellPage";
import {
  hexId,
  mockEvent,
  type MockEvent,
  type MockRelay,
} from "./helpers/mockRelay";

// Local verification attaches to Agent Brave. CI retains its normal browser.
const test = base.extend({
  context: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL });
    await use(context);
    await context.close();
  },
  browser: async (
    { browserName, playwright, launchOptions, headless },
    use,
  ) => {
    const browser = process.env.E2E_CDP
      ? await chromium.connectOverCDP(process.env.E2E_CDP)
      : await playwright[browserName].launch({ ...launchOptions, headless });
    await use(browser);
    // Disconnecting from CDP must never close the shared browser.
    if (!process.env.E2E_CDP) await browser.close();
  },
});

function metadataEcho() {
  let clock = Math.floor(Date.now() / 1000);
  return (event: MockEvent, relay: MockRelay) => {
    if (event.kind !== 9002) return;
    const id = event.tags.find((tag) => tag[0] === "h")?.[1];
    const old = relay
      .served()
      .find(
        (item) =>
          item.kind === 39000 &&
          item.tags.some((tag) => tag[0] === "d" && tag[1] === id),
      );
    if (!old) throw new Error("Missing channel fixture");
    let tags = old.tags;
    for (const [key, value] of event.tags) {
      if (key === "h") continue;
      const removes =
        key === "visibility"
          ? ["private", "public"]
          : key === "ttl"
            ? ["ttl", "ttl_deadline"]
            : [key];
      tags = tags.filter((tag) => !removes.includes(tag[0]));
      if (key === "visibility")
        tags.push([value === "private" ? "private" : "public"]);
      else if (key === "ttl" && value !== "")
        tags.push(
          ["ttl", value],
          [
            "ttl_deadline",
            new Date((clock + Number(value)) * 1000).toISOString(),
          ],
        );
      else if (
        !(key === "archived" && value === "false") &&
        !(key === "ttl" && value === "")
      )
        tags.push([key, value]);
    }
    relay.remove((item) => item.id === old.id);
    // Metadata is served to the client's bounded replays, without mock-only fan-out.
    relay.add(
      mockEvent({ ...old, id: hexId(++clock), created_at: clock, tags }),
    );
  };
}

for (const theme of [
  { name: "dark", id: "buzz-dark" },
  { name: "light", id: "buzz" },
]) {
  for (const width of [1440, 390]) {
    test(`channel sheet About at ${width} ${theme.name}: edit, archive, lifetime and members`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      const { relay } = await openShell(page, {
        theme: theme.id,
        path: channelPath(),
        extra: (fixture) => [
          mockEvent({
            kind: 39002,
            id: hexId(6000),
            tags: [
              ["d", fixture.channels["flight-path"]],
              ["h", fixture.channels["flight-path"]],
              ["p", fixture.viewer],
              ...[
                fixture.agents.acid,
                fixture.agents.cereal,
                fixture.agents.gilfoyle,
                fixture.agents.nikon,
              ].map((agent) => ["p", agent.pubkey]),
            ],
          }),
        ],
        relay: { onPublish: metadataEcho() },
      });
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`\\b${theme.name}\\b`),
      );
      await page.getByTestId("channel-settings-trigger").click();
      const sheet = page.getByTestId("channel-settings-sheet");
      await expect(sheet).toBeVisible();
      await sheet.evaluate((element) =>
        Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      const rect = await sheet.boundingBox();
      expect(rect).not.toBeNull();
      expect(Math.round(rect?.width ?? 0)).toBe(width === 390 ? 390 : 480);
      expect(Math.round(rect?.x ?? 0)).toBe(width === 390 ? 0 : 960);
      expect(
        await sheet.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await expect(
        sheet.getByRole("tab", { name: "Members (5)" }),
      ).toBeVisible();
      await shot(page, `w1-about-${width}-${theme.name}`);
      await page
        .getByRole("button", { name: "Edit purpose", exact: true })
        .click();
      await page
        .getByLabel("Channel purpose")
        .fill("W1 purpose from the settings sheet");
      await sheet.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        sheet.getByText("W1 purpose from the settings sheet", { exact: true }),
      ).toBeVisible();
      const purpose = relay.published.find(
        (event) =>
          event.kind === 9002 && event.tags.some((tag) => tag[0] === "purpose"),
      );
      expect(purpose?.tags).toEqual([
        ["h", purpose?.tags[0][1]],
        ["purpose", "W1 purpose from the settings sheet"],
      ]);
      await sheet
        .getByRole("button", { name: "Archive channel", exact: false })
        .click();
      await expect(
        sheet.getByRole("button", { name: "Unarchive channel", exact: false }),
      ).toBeVisible();
      await expect(
        sheet.getByRole("button", { name: "Edit name" }),
      ).toBeDisabled();
      await expect(sheet.getByLabel("Lifetime")).toBeDisabled();
      await sheet
        .getByRole("button", { name: "Unarchive channel", exact: false })
        .click();
      await expect(
        sheet.getByRole("button", { name: "Edit name" }),
      ).toBeEnabled();
      await sheet.getByLabel("Lifetime").selectOption("86400");
      await expect(sheet.getByLabel("Lifetime")).toHaveValue("86400");
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      if (width === 1440)
        await expect(page.getByTestId("channel-header")).toContainText(
          "W1 purpose from the settings sheet",
        );
      await expect(page.getByTestId("channel-expiry-badge")).toBeVisible();
      await expect(mainComposer(page)).toBeEnabled();
      await page.getByTestId("channel-members-trigger").click();
      await expect(page.getByRole("tab", { name: /Members/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.getByRole("tab", { name: "About", exact: true }).click();
      await sheet
        .getByRole("button", { name: "Archive channel", exact: false })
        .click();
      await expect(
        sheet.getByRole("button", { name: "Unarchive channel", exact: false }),
      ).toBeVisible();
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByTestId("archived-composer")).toBeVisible();
      await expect(mainComposer(page)).toBeDisabled();
      await page.getByTestId("channel-settings-trigger").click();
      await expect(
        sheet.getByRole("button", { name: "Unarchive channel", exact: false }),
      ).toBeVisible();
    });
  }
}
