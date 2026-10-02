import { chromium, expect, test as base, type Page } from "@playwright/test";
import { verifyEvent } from "nostr-tools/pure";
import { channelPath, openShell, shot } from "./helpers/shellPage";
import {
  hexId,
  installMockRelay,
  mockEvent,
  type MockEvent,
} from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";

// Local checks use Agent Brave. CI retains its ordinary browser lifecycle.
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

async function openCanvas(page: Page) {
  await page.getByTestId("channel-settings-trigger").click();
  await page
    .getByTestId("channel-settings-sheet")
    .getByRole("button", { name: "Canvas", exact: true })
    .click();
  const canvas = page.getByTestId("channel-canvas").filter({ visible: true });
  await expect(canvas).toBeVisible();
  await expect(
    canvas.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  return canvas;
}

for (const theme of [
  { name: "dark", id: "buzz-dark" },
  { name: "light", id: "buzz" },
]) {
  for (const width of [1440, 390]) {
    test(`canvas edit at ${width} ${theme.name}: create, echo to second viewer, refusal and clear`, async ({
      page,
      browser,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 960 });
      let accepted: MockEvent | undefined;
      let refuse = false;
      const { fixture, relay } = await openShell(page, {
        theme: theme.id,
        path: channelPath(),
        extra: (fixture) => [
          mockEvent({
            id: hexId(8000),
            kind: 39002,
            tags: [
              ["d", fixture.channels["flight-path"]],
              ["h", fixture.channels["flight-path"]],
              ["p", fixture.viewer],
            ],
          }),
        ],
        relay: {
          rejectPublish: (event) =>
            event.kind === 40100 && refuse
              ? "Only channel members can write the canvas"
              : null,
          onPublish: (event) => {
            if (event.kind === 40100) accepted = event;
          },
        },
      });
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`\\b${theme.name}\\b`),
      );
      const canvas = await openCanvas(page);
      await expect(canvas.getByTestId("channel-canvas-empty")).toBeVisible();
      await canvas.getByRole("button", { name: "Edit", exact: true }).click();
      const markdown =
        "# W5a team notes\n\nA shared **canvas** at any width.\n\n- Save through the channel\n- Read together";
      await canvas.getByLabel("Canvas markdown").fill(markdown);
      await shot(page, `w5a-edit-${width}-${theme.name}`);
      await canvas.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => accepted?.content).toBe(markdown);
      const saved = accepted;
      if (!saved) throw new Error("Missing canvas publish");
      expect(saved.tags).toEqual([["h", fixture.channels["flight-path"]]]);
      expect(verifyEvent(saved)).toBe(true);
      // An OK alone cannot invent content; deliberately hold the echo.
      await expect(canvas.getByTestId("channel-canvas-empty")).toBeVisible();
      relay.push(saved);
      await expect(
        canvas.getByRole("heading", { name: "W5a team notes" }),
      ).toBeVisible();
      await shot(page, `w5a-saved-${width}-${theme.name}`);
      expect(
        await canvas.evaluate(
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
      if (width === 390) {
        const bounds = await page
          .getByTestId("channel-canvas-sheet")
          .boundingBox();
        expect(Math.round(bounds?.width ?? 0)).toBe(390);
      }

      const readerContext = await browser.newContext({
        baseURL,
        viewport: { width: 1440, height: 960 },
      });
      const reader = await readerContext.newPage();
      try {
        const secondRelay = await installMockRelay(reader, [
          ...fixture.events,
          ...relay.served().filter((event) => event.kind === 39002),
        ]);
        await signIn(reader, channelPath()(fixture), fixture.viewerKey);
        const second = await openCanvas(reader);
        await expect(second.getByTestId("channel-canvas-empty")).toBeVisible();
        secondRelay.push(saved);
        await expect(
          second.getByRole("heading", { name: "W5a team notes" }),
        ).toBeVisible();

        await canvas.getByRole("button", { name: "Edit", exact: true }).click();
        await canvas
          .getByLabel("Canvas markdown")
          .fill("Keep my refused draft");
        refuse = true;
        await canvas.getByRole("button", { name: "Save", exact: true }).click();
        await expect(canvas.getByRole("alert")).toHaveText(
          "Only channel members can write the canvas",
        );
        await expect(canvas.getByLabel("Canvas markdown")).toHaveValue(
          "Keep my refused draft",
        );
        await canvas
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        refuse = false;
        // Other CDP clients can dismiss native dialogs in the shared browser.
        // Accept this page's confirmation and assert its prompt; unit tests
        // separately exercise cancellation without sending an event.
        await page.evaluate(() => {
          window.confirm = (message) => {
            document.documentElement.dataset.canvasConfirmation = message;
            return true;
          };
        });
        await canvas
          .getByRole("button", { name: "Clear", exact: true })
          .click();
        await expect(page.locator("html")).toHaveAttribute(
          "data-canvas-confirmation",
          "Clear the canvas for everyone in this channel?",
        );
        await expect.poll(() => accepted?.content).toBe("");
        const cleared = accepted;
        if (!cleared) throw new Error("Missing clear publish");
        expect(cleared.id).not.toBe(saved.id);
        expect(cleared.created_at).toBeGreaterThan(saved.created_at);
        relay.push(cleared);
        secondRelay.push(cleared);
        await expect(canvas.getByTestId("channel-canvas-empty")).toBeVisible();
        await expect(second.getByTestId("channel-canvas-empty")).toBeVisible();
        await expect(
          canvas.getByRole("button", { name: "Edit", exact: true }),
        ).toBeVisible();
        await shot(page, `w5a-clear-${width}-${theme.name}`);
        if (width === 390) {
          await page.getByRole("button", { name: "Close canvas" }).click();
          await expect(page.getByTestId("channel-canvas-sheet")).toBeHidden();
          await openCanvas(page);
          await expect(
            canvas.getByTestId("channel-canvas-empty"),
          ).toBeVisible();
        }
      } finally {
        await readerContext.close();
      }
    });
  }
}
