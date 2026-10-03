import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/agentBraveTest";
import { hexId, mockEvent } from "./helpers/mockRelay";
import { channelPath, mainComposer, openShell } from "./helpers/shellPage";

const ROOT = hexId(90001);
const NEXT = hexId(90003);

async function openConversation(page: Page, theme: string, sidebar = 260) {
  await page.addInitScript(
    ({ sidebar }) => {
      localStorage.setItem("buzz.sidebar-width.v1", String(sidebar));
      // The reported 1054px / 238px failure needs a previously resized dock.
      localStorage.setItem("buzz.work-width.v1", "540");
    },
    { sidebar },
  );
  await openShell(page, {
    theme,
    path: channelPath(),
    extra: (fixture) => {
      const channel = fixture.channels["flight-path"];
      fixture.events = fixture.events.filter((event) => event.kind !== 9);
      const now = Math.floor(Date.now() / 1000) - 100;
      return [
        mockEvent({
          id: ROOT,
          kind: 9,
          pubkey: fixture.viewer,
          created_at: now,
          tags: [["h", channel]],
          content: "This open thread has a reply box that must stay clickable.",
        }),
        mockEvent({
          id: hexId(90002),
          kind: 9,
          pubkey: fixture.agents.nikon.pubkey,
          created_at: now + 10,
          tags: [
            ["h", channel],
            ["e", ROOT, "", "root"],
            ["e", ROOT, "", "reply"],
          ],
          content: "Continue the conversation below.",
        }),
        mockEvent({
          id: NEXT,
          kind: 9,
          pubkey: fixture.agents.gilfoyle.pubkey,
          created_at: now + 20,
          tags: [["h", channel]],
          content: "Hover this neighbouring message to show its actions.",
        }),
        mockEvent({
          id: hexId(90004),
          kind: 40100,
          pubkey: fixture.viewer,
          created_at: now + 30,
          tags: [["h", channel]],
          content: "# Shared canvas\n\nKeep the conversation readable.",
        }),
      ];
    },
  });
  await expect(page.getByTestId(`message-row-${NEXT}`)).toBeVisible();
  await expect(page.getByTestId(`thread-chip-${ROOT}`)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
}

async function openCanvas(page: Page) {
  await page.getByTestId("channel-settings-trigger").click();
  await page
    .getByTestId("channel-settings-sheet")
    .getByRole("button", { name: "Canvas", exact: true })
    .click();
  await expect(
    page.getByTestId("channel-canvas").filter({ visible: true }),
  ).toBeVisible();
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

for (const theme of ["buzz", "buzz-dark"]) {
  for (const width of [1440, 1280, 1054, 900]) {
    test(`Canvas preserves conversation width at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openConversation(page, theme);
      await openCanvas(page);
      const main = page.locator(".buzz-content-scrollbar > main");
      await expect
        .poll(async () => (await main.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(400);
      await noOverflow(page);
      if (width < 1024) {
        await expect(page.getByTestId("channel-canvas-sheet")).toBeVisible();
        await page.getByRole("button", { name: "Close canvas" }).click();
      } else {
        const dock = await page.getByTestId("right-dock").boundingBox();
        expect(dock?.width).toBeGreaterThanOrEqual(320);
        const chat = await main.boundingBox();
        expect(dock?.x).toBeGreaterThanOrEqual(
          (chat?.x ?? 0) + (chat?.width ?? 0),
        );
        // The main send button remains wholly within the conversation.
        await mainComposer(page).fill("A readable draft");
        const send = await main
          .getByRole("button", { name: "Send message", exact: true })
          .boundingBox();
        expect(send?.x).toBeGreaterThanOrEqual(chat?.x ?? 0);
        expect((send?.x ?? 0) + (send?.width ?? 0)).toBeLessThanOrEqual(
          (chat?.x ?? 0) + (chat?.width ?? 0),
        );
      }
    });

    test(`Neighbour toolbar leaves thread reply clickable at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openConversation(page, theme);
      const neighbour = page.getByTestId(`message-row-${NEXT}`);
      await neighbour.hover();
      const toolbar = page.getByTestId(`message-action-bar-${NEXT}`);
      await expect(toolbar).toHaveCSS("opacity", "1");
      const row = await neighbour.boundingBox();
      const bar = await toolbar.boundingBox();
      const box = page
        .getByTestId(`inline-thread-${ROOT}`)
        .getByTestId("thread-reply-box");
      const reply = await box.boundingBox();
      expect(row && bar && reply).toBeTruthy();
      expect(bar?.y).toBeGreaterThanOrEqual(row?.y ?? 0);
      expect(bar?.y).toBeGreaterThanOrEqual(
        (reply?.y ?? 0) + (reply?.height ?? 0),
      );
      const input = box.getByTestId("composer-input");
      expect(
        await input.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(rect.right - 3, rect.bottom - 3),
          );
        }),
      ).toBe(true);
      await input.click();
      await expect(input).toBeFocused();
      await input.fill("The reply box works while the neighbour is hovered.");
      await neighbour.hover();
      await expect(toolbar).toHaveCSS("opacity", "1");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(
        "The reply box works while the neighbour is hovered.",
      );
    });
  }

  test(`Canvas overlays a row too narrow for both panes ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1054, height: 900 });
    await openConversation(page, theme, 480);
    await openCanvas(page);
    const main = page.locator(".buzz-content-scrollbar > main");
    const dock = page.getByTestId("right-dock");
    await expect(dock).toHaveCSS("position", "absolute");
    expect((await main.boundingBox())?.width).toBeGreaterThanOrEqual(400);
    const chatBounds = await main.boundingBox();
    const dockBounds = await dock.boundingBox();
    expect(dockBounds?.x).toBe(chatBounds?.x);
    expect(dockBounds?.width).toBe(chatBounds?.width);
    await expect(page.getByLabel("Resize side panel")).toBeHidden();
    await noOverflow(page);
    await page.getByTestId("right-pane-tab-work").click();
    await expect(page.getByTestId("channel-canvas")).toHaveCount(0);
    await expect(mainComposer(page)).toBeVisible();
  });
}
