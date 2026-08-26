import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// The panel URL is a live tailnet origin; e2e must not depend on it (or on
// its auth), so every request it would make is aborted at the network layer.
// Assertions read iframe attributes, never iframe content.
const PANEL_URL = "https://crichton.tailb3d4b8.ts.net:6201/?panel=files";

// This spec covers the IFRAME FALLBACK path only: the e2e build forces
// `render: "iframe"` (see webPanels.config.ts — plain chromium has no Tauri
// child webviews and its IPC is mocked). The native path's geometry loop,
// webview lifecycle, and IPC contract are covered by
// src/features/webPanels/*.test.mjs against the real invoke boundary.

test.describe("web panels (iframe fallback)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/tailb3d4b8\.ts\.net/, (route) => route.abort());
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
  });

  test("header button opens the configured panel in the bottom dock", async ({
    page,
  }) => {
    const button = page.getByRole("button", { name: "Toggle Files panel" });
    await expect(button).toBeVisible();
    await button.click();

    const substrate = page.locator(".buzz-webpanel-substrate");
    await expect(substrate).toBeVisible();
    await expect(substrate).toHaveAttribute("data-webpanel-mode", "docked");
    // e2e builds force the iframe fallback.
    await expect(substrate).toHaveAttribute("data-webpanel-render", "iframe");

    const frame = substrate.locator("iframe.buzz-webpanel-frame");
    await expect(frame).toHaveAttribute("src", PANEL_URL);
    await expect(frame).toHaveAttribute("title", "Files");
    // No sandbox attribute: the panel app needs cookies and downloads.
    await expect(frame).not.toHaveAttribute("sandbox");
  });

  test("the tab strip opens a second instance of the same panel type", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("menuitem", { name: "Files" }).click();

    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(2);
    // Both instances stay mounted; only the active one is visible.
    const frames = page.locator("iframe.buzz-webpanel-frame");
    await expect(frames).toHaveCount(2);
    await expect(frames.nth(0)).toBeAttached();
    await expect(frames.nth(0)).not.toBeVisible();
    await expect(frames.nth(1)).toBeVisible();
    await expect(frames.nth(1)).toHaveAttribute("src", PANEL_URL);
  });

  test("switching tabs swaps the visible instance without unmounting either", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("menuitem", { name: "Files" }).click();

    const tabs = page.locator('[role="tab"]');
    await tabs.nth(0).click();
    const frames = page.locator("iframe.buzz-webpanel-frame");
    await expect(frames.nth(0)).toBeVisible();
    await expect(frames.nth(1)).not.toBeVisible();
    // Keep-alive: the inactive tab's frame is still in the dom.
    await expect(frames.nth(1)).toBeAttached();
  });

  test("closing a tab removes exactly that instance; the last close dismisses the dock", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("menuitem", { name: "Files" }).click();

    await page.getByLabel("Close Files tab").nth(1).click();
    await expect(page.locator('[role="tab"]')).toHaveCount(1);
    await expect(page.locator("iframe.buzz-webpanel-frame")).toHaveCount(1);

    await page.getByLabel("Close Files tab").click();
    await expect(page.locator(".buzz-webpanel-substrate")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("hide closes the dock and unmounts the panels", async ({ page }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await expect(page.locator(".buzz-webpanel-substrate")).toBeVisible();

    await page.getByRole("button", { name: "Hide web panels" }).click();
    const substrate = page.locator(".buzz-webpanel-substrate");
    await expect(substrate).toHaveAttribute("data-webpanel-visible", "false");
    // The bootstrap keeps the node mounted through the 180ms close
    // transition, then drops it entirely.
    await expect(substrate).toHaveCount(0, { timeout: 5_000 });
  });

  test("toggling the header button again closes the dock", async ({ page }) => {
    const button = page.getByRole("button", { name: "Toggle Files panel" });
    await button.click();
    await expect(page.locator(".buzz-webpanel-substrate")).toBeVisible();
    await button.click();
    await expect(page.locator(".buzz-webpanel-substrate")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("maximize takes over the content column and hides the resize handle", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByRole("button", { name: "Maximize panel" }).click();

    const substrate = page.locator(".buzz-webpanel-substrate");
    await expect(substrate).toHaveAttribute("data-webpanel-mode", "maximized");
    // The resize handle is a separator (<hr>), not a button.
    await expect(page.getByLabel("Resize Files panel")).toHaveCount(0);

    // The host rule is what drives maximize (the content-primary collapse
    // rule sits in the components layer and, like the terminal's, loses to
    // the flex-1 utility). Assert the dock host actually takes the column.
    const host = page.locator(".buzz-webpanel-dock-host");
    await expect
      .poll(async () =>
        host.evaluate((el) =>
          getComputedStyle(el).getPropertyValue("flex-grow"),
        ),
      )
      .toBe("1");

    await page.getByRole("button", { name: "Restore panel" }).click();
    await expect(substrate).toHaveAttribute("data-webpanel-mode", "docked");
    await expect(page.getByLabel("Resize Files panel")).toBeVisible();
  });

  test("reload keeps the same url and the login click stays contained", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    const substrate = page.locator(".buzz-webpanel-substrate");

    await page.getByRole("button", { name: "Reload Files" }).click();
    await expect(substrate.locator("iframe")).toHaveAttribute("src", PANEL_URL);

    // The login hop targets a real Tauri command; the mock bridge has none,
    // so the error path must be contained (panel stays usable).
    await page.getByRole("button", { name: "Log in to Files" }).click();
    await expect(substrate).toBeVisible();
    await expect(substrate.locator("iframe")).toHaveAttribute("src", PANEL_URL);
  });

  test("the panel session restores after a reload", async ({ page }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("menuitem", { name: "Files" }).click();
    await expect(page.locator('[role="tab"]')).toHaveCount(2);

    // Reload simulates the boot path: tabs, order, and the active tab come
    // back from the persisted session. (The write is debounced, so wait for
    // the key before reloading.)
    await page.waitForFunction(
      () => localStorage.getItem("buzz-webpanel-session") !== null,
    );
    await page.reload();
    await installMockBridge(page);
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await expect(page.locator('[role="tab"]')).toHaveCount(2);
    const frames = page.locator("iframe.buzz-webpanel-frame");
    await expect(frames).toHaveCount(2);
    await expect(frames.nth(1)).toBeVisible();
    await expect(frames.nth(0)).not.toBeVisible();
  });
});
