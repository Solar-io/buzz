import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// The panel URL is a live tailnet origin; e2e must not depend on it (or on
// its auth), so every request it would make is aborted at the network layer.
// Assertions read iframe attributes, never iframe content.
const PANEL_URL = "https://crichton.tailb3d4b8.ts.net:6201/?panel=files";

test.describe("web panels", () => {
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
    const button = page.getByRole("button", { name: "Open Files panel" });
    await expect(button).toBeVisible();
    await button.click();

    const substrate = page.locator(".buzz-webpanel-substrate");
    await expect(substrate).toBeVisible();
    await expect(substrate).toHaveAttribute("data-webpanel-mode", "docked");

    const frame = substrate.locator("iframe.buzz-webpanel-frame");
    await expect(frame).toHaveAttribute("src", PANEL_URL);
    await expect(frame).toHaveAttribute("title", "Files");
    // No sandbox attribute: the panel app needs cookies and downloads.
    await expect(frame).not.toHaveAttribute("sandbox");
  });

  test("hide closes the dock and unmounts the panel", async ({ page }) => {
    await page.getByRole("button", { name: "Open Files panel" }).click();
    await expect(page.locator(".buzz-webpanel-substrate")).toBeVisible();

    await page.getByRole("button", { name: "Hide Files panel" }).click();
    const substrate = page.locator(".buzz-webpanel-substrate");
    await expect(substrate).toHaveAttribute("data-webpanel-visible", "false");
    // The bootstrap keeps the node mounted through the 180ms close
    // transition, then drops it entirely.
    await expect(substrate).toHaveCount(0, { timeout: 5_000 });
  });

  test("toggling the button again closes the panel", async ({ page }) => {
    const button = page.getByRole("button", { name: "Open Files panel" });
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
    await page.getByRole("button", { name: "Open Files panel" }).click();
    await page.getByRole("button", { name: "Maximize Files panel" }).click();

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

    await page.getByRole("button", { name: "Restore Files panel" }).click();
    await expect(substrate).toHaveAttribute("data-webpanel-mode", "docked");
    await expect(page.getByLabel("Resize Files panel")).toBeVisible();
  });

  test("reload keeps the same url and the login click stays contained", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open Files panel" }).click();
    const substrate = page.locator(".buzz-webpanel-substrate");

    await page.getByRole("button", { name: "Reload Files" }).click();
    await expect(substrate.locator("iframe")).toHaveAttribute("src", PANEL_URL);

    // The login hop targets a real Tauri command; the mock bridge has none,
    // so the error path must be contained (panel stays usable).
    await page.getByRole("button", { name: "Log in to Files" }).click();
    await expect(substrate).toBeVisible();
    await expect(substrate.locator("iframe")).toHaveAttribute("src", PANEL_URL);
  });
});
