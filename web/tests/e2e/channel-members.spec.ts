import { chromium, expect, test as base } from "@playwright/test";
import { channelPath, openShell, shot } from "./helpers/shellPage";
import {
  hexId,
  mockEvent,
  type MockEvent,
  type MockRelay,
} from "./helpers/mockRelay";

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
    if (!process.env.E2E_CDP) await browser.close();
  },
});
const ALEX = "31".repeat(32),
  TAYLOR = "32".repeat(32);

function membersEcho() {
  let clock = Math.floor(Date.now() / 1000) + 10;
  return (event: MockEvent, relay: MockRelay) => {
    if (![9000, 9001].includes(event.kind)) return;
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    const pubkey = event.tags.find((tag) => tag[0] === "p")?.[1];
    const old = relay
      .served()
      .find(
        (item) =>
          item.kind === 39002 &&
          item.tags.some((tag) => tag[0] === "d" && tag[1] === channel),
      );
    if (!old || !pubkey) throw new Error("Missing membership fixture");
    const tags = old.tags.filter(
      (tag) => !(tag[0] === "p" && tag[1] === pubkey),
    );
    if (event.kind === 9000)
      tags.push([
        "p",
        pubkey,
        "",
        event.tags.find((tag) => tag[0] === "role")?.[1] ?? "member",
      ]);
    relay.remove((item) => item.id === old.id);
    relay.push(
      mockEvent({ ...old, id: hexId(++clock), created_at: clock, tags }),
    );
  };
}

for (const theme of [
  { name: "dark", id: "buzz-dark" },
  { name: "light", id: "buzz" },
]) {
  for (const width of [1440, 390, 375]) {
    test(`channel people at ${width} ${theme.name}: Guest, role, reload, remove and community ban`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 960 });
      page.on("dialog", (dialog) => dialog.accept());
      const { relay, fixture } = await openShell(page, {
        theme: theme.id,
        path: channelPath(),
        relay: { onPublish: membersEcho() },
        extra: (fixture) => [
          mockEvent({
            id: hexId(90001),
            kind: 39002,
            tags: [
              ["d", fixture.channels["flight-path"]],
              ["h", fixture.channels["flight-path"]],
              ["p", fixture.viewer, "", "owner"],
              ["p", ALEX, "", "member"],
              ["p", fixture.agents.acid.pubkey, "", "bot"],
            ],
          }),
          mockEvent({
            id: hexId(90002),
            kind: 13534,
            tags: [
              ["member", fixture.viewer, "owner"],
              ["member", ALEX, "member"],
              ["member", TAYLOR, "member"],
            ],
          }),
          ...[
            [ALEX, "Alex Rivera"],
            [TAYLOR, "Taylor Morgan"],
          ].map(([pubkey, name], i) =>
            mockEvent({
              id: hexId(90003 + i),
              kind: 0,
              pubkey,
              content: JSON.stringify({ display_name: name }),
            }),
          ),
        ],
      });
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`\\b${theme.name}\\b`),
      );
      await page.getByTestId("channel-members-trigger").click();
      const sheet = page.getByTestId("channel-settings-sheet");
      await expect(sheet.getByLabel("Role for Alex Rivera")).toHaveValue(
        "member",
      );
      const self = sheet
        .getByRole("combobox")
        .filter({ has: page.locator('option[value="owner"]:checked') });
      await expect(self).toBeDisabled();
      await expect(self).toHaveAttribute("title", "A channel needs an owner");
      const bounds = await sheet.boundingBox();
      expect(Math.round(bounds?.width ?? 0)).toBe(width < 640 ? width : 480);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      expect(
        await sheet.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await shot(page, `w2-members-${width}-${theme.name}`);
      await sheet.getByRole("button", { name: "People", exact: true }).click();
      const picker = page.getByRole("dialog", {
        name: "Add people",
        exact: true,
      });
      await picker
        .getByRole("button", { name: "Select Taylor Morgan" })
        .click();
      await picker
        .getByLabel("Invite role for Taylor Morgan")
        .selectOption("guest");
      expect(
        await picker.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await shot(page, `w2-invite-${width}-${theme.name}`);
      await picker
        .getByRole("button", { name: "Add people", exact: true })
        .click();
      await expect(sheet.getByLabel("Role for Taylor Morgan")).toHaveValue(
        "guest",
      );
      expect(
        relay.published.find((event) => event.kind === 9000)?.tags,
      ).toEqual([
        ["h", fixture.channels["flight-path"]],
        ["p", TAYLOR],
        ["role", "guest"],
      ]);
      await sheet.getByLabel("Role for Taylor Morgan").selectOption("member");
      await expect(sheet.getByLabel("Role for Taylor Morgan")).toHaveValue(
        "member",
      );
      await page.reload();
      await page.getByTestId("channel-members-trigger").click();
      await expect(sheet.getByLabel("Role for Taylor Morgan")).toHaveValue(
        "member",
      );
      await sheet
        .getByRole("button", { name: "More for Taylor Morgan" })
        .click();
      await page.getByRole("menuitem", { name: "Remove from channel" }).click();
      await expect(sheet.getByLabel("Role for Taylor Morgan")).toHaveCount(0);
      expect(
        relay.published.find((event) => event.kind === 9001)?.tags,
      ).toEqual([
        ["h", fixture.channels["flight-path"]],
        ["p", TAYLOR],
      ]);
      await sheet.getByRole("button", { name: "More for Alex Rivera" }).click();
      await expect(
        page.getByRole("menuitem", { name: "Time out from community…" }),
      ).toBeVisible();
      await page.getByRole("menuitem", { name: "Ban from community…" }).click();
      const moderation = page.getByRole("dialog", {
        name: "Ban from community",
        exact: true,
      });
      await expect(
        moderation.getByRole("button", {
          name: "Ban from community",
          exact: true,
        }),
      ).toBeDisabled();
      await moderation
        .getByLabel("Reason")
        .fill("Repeated spam in the private test fixture");
      await shot(page, `w2-ban-${width}-${theme.name}`);
      await moderation
        .getByRole("button", { name: "Ban from community", exact: true })
        .click();
      expect(
        relay.published.find((event) => event.kind === 9040)?.tags,
      ).toEqual([
        ["p", ALEX],
        ["reason", "Repeated spam in the private test fixture"],
      ]);
    });
  }
}

test("non-admin channel viewer has no role or moderation controls", async ({
  page,
}) => {
  await openShell(page, {
    theme: "buzz-dark",
    path: channelPath(),
    extra: (fixture) => [
      mockEvent({
        id: hexId(99001),
        kind: 39002,
        tags: [
          ["d", fixture.channels["flight-path"]],
          ["h", fixture.channels["flight-path"]],
          ["p", fixture.viewer, "", "member"],
          ["p", ALEX, "", "owner"],
        ],
      }),
      mockEvent({
        id: hexId(99002),
        kind: 13534,
        tags: [["member", fixture.viewer, "member"]],
      }),
      mockEvent({
        id: hexId(99003),
        kind: 0,
        pubkey: ALEX,
        content: JSON.stringify({ display_name: "Alex Rivera" }),
      }),
    ],
  });
  await page.getByTestId("channel-members-trigger").click();
  const sheet = page.getByTestId("channel-settings-sheet");
  await expect(sheet.getByText("Alex Rivera", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("combobox")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /More for/ })).toHaveCount(0);
});
