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

// Owner-added custom sites, driven through the mocked custom-panel store
// (see e2eBridge `customWebPanels` seed + the add/remove command mocks —
// the real dialogs are native OS surfaces Playwright cannot reach).
// Customs render NATIVE even in the iframe-forced e2e build: their URL
// never crosses the IPC boundary (no frame to build), so the registry pins
// render:"native" and the substrate hosts them through the native
// placeholder path with the nav controls beside Reload. The mocked
// ensure/visible/destroy commands let that path run for real.
test.describe("web panels (custom sites)", () => {
  const SEED = [{ id: "site-1", label: "Wiki", url: "https://wiki.example/" }];

  test.beforeEach(async ({ page }) => {
    await page.route(/tailb3d4b8\.ts\.net/, (route) => route.abort());
    // The seeded site's origin must never actually load in this spec.
    await page.route(/(wiki|docs)\.example/, (route) => route.abort());
    await installMockBridge(page, { customWebPanels: SEED });
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
  });

  test("a seeded custom site opens a native-only tab from the picker", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    // The picker lists the owner site and the add affordance.
    await expect(page.getByRole("menuitem", { name: "Wiki" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Add site…" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Wiki" }).click();

    await expect(page.locator('[role="tab"]')).toHaveCount(2);
    await expect(page.getByRole("tab", { name: "Wiki" })).toBeVisible();
    // The custom tab is native by construction: no URL ever crossed the
    // IPC boundary, so there is no frame to build. In the iframe-forced
    // e2e build the content area explains that instead (production gets
    // the real native placeholder + child webview).
    await expect(page.locator(".buzz-webpanel-custom-note")).toHaveText(
      "Wiki opens in the native panel view",
    );
    // The Files tab's iframe is not mounted while the native tab owns the
    // viewport (keep-alive applies within a render family, not across it).
    await expect(page.locator("iframe.buzz-webpanel-frame")).toHaveCount(0);
    await expect(
      page.locator(".buzz-webpanel-native-placeholder"),
    ).toHaveCount(0);
    // Nav controls ride the native path for the custom tab.
    await expect(
      page.getByRole("button", { name: "Go back in Wiki" }),
    ).toBeVisible();
  });

  test("the add-site flow appends a custom tab through the mocked IPC", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    // The mocked add_custom_panel appends a "Docs" site and returns it.
    await page.getByRole("menuitem", { name: "Add site…" }).click();

    await expect(page.locator('[role="tab"]')).toHaveCount(2);
    await expect(page.getByRole("tab", { name: "Docs" })).toBeVisible();
    // Native-only: the note stands in for a frame in the iframe-forced
    // build (the URL never crossed the IPC boundary).
    await expect(page.locator(".buzz-webpanel-custom-note")).toHaveText(
      "Docs opens in the native panel view",
    );
    const commands = await commandsSeen(page);
    expect(commands).toContain("add_custom_panel");
    expect(commands).toContain("list_custom_panels");
    // The refreshed registry now offers both sites in the picker.
    await page.getByLabel("Open a new panel tab").click();
    await expect(page.getByRole("menuitem", { name: "Wiki" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Docs" })).toBeVisible();
  });

  test("removing a site closes its open tabs through the store path", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("menuitem", { name: "Wiki" }).click();
    await expect(page.locator('[role="tab"]')).toHaveCount(2);

    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("button", { name: "Remove site Wiki" }).click();

    // The custom tab is gone; the Files tab and its frame remain.
    await expect(page.locator('[role="tab"]')).toHaveCount(1);
    await expect(page.getByRole("tab", { name: "Wiki" })).toHaveCount(0);
    await expect(page.locator("iframe.buzz-webpanel-frame")).toHaveCount(1);
    const commands = await commandsSeen(page);
    expect(commands).toContain("remove_custom_panel");
  });

  test("custom tabs restore after a reload (registry resolves first)", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("menuitem", { name: "Wiki" }).click();
    await expect(page.locator('[role="tab"]')).toHaveCount(2);

    // Reload simulates the boot path. Restore is gated on the custom
    // registry resolving first, so the site-1 tab must still come back —
    // an ungated restore would drop it as an unknown panel id.
    await page.waitForFunction(
      () => localStorage.getItem("buzz-webpanel-session") !== null,
    );
    await page.reload();
    // The mocked list "persists" by re-seeding the same site.
    await installMockBridge(page, { customWebPanels: SEED });
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await expect(page.locator('[role="tab"]')).toHaveCount(2);
    await expect(page.getByRole("tab", { name: "Wiki" })).toBeVisible();
  });

  test("navigation controls dispatch home/back/forward for custom tabs only", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Toggle Files panel" }).click();
    // The static Files tab is iframe-rendered in e2e: Reload only.
    await expect(
      page.getByRole("button", { name: "Reload Files" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Go back in Files" }),
    ).toHaveCount(0);

    await page.getByLabel("Open a new panel tab").click();
    await page.getByRole("menuitem", { name: "Wiki" }).click();
    // A custom tab keeps its native render mode, so the nav group shows.
    await page.getByRole("button", { name: "Go back in Wiki" }).click();
    await page.getByRole("button", { name: "Go forward in Wiki" }).click();
    await page.getByRole("button", { name: "Open Wiki home" }).click();

    await expect
      .poll(async () => {
        const commands = await commandsSeen(page);
        return [
          commands.includes("web_panel_back"),
          commands.includes("web_panel_forward"),
          commands.includes("web_panel_home"),
        ];
      })
      .toEqual([true, true, true]);
  });
});

/** Every mocked Tauri command the page has invoked so far. */
async function commandsSeen(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    return (
      (window as unknown as { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? []
    );
  });
}
