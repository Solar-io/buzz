import { expect, type Page, test } from "@playwright/test";

import { openPalette, signInAndOpenShell } from "./helpers/signIn";

/**
 * The surfaces added for desktop parity, loaded in a real browser.
 *
 * This closes the "shipped and dead" hole for work that is NOT a `?view=`
 * pane: the community roster and presence controls live in Settings, the
 * search palette is raised by a keystroke, and the panel dock is behind the
 * Files action. Every one of them is imported from exactly one place, so a
 * unit test cannot tell "correct" from "never rendered".
 *
 * No relay is running, which is deliberate rather than a limitation: each
 * surface's empty state is what a signed-in viewer sees before any data
 * arrives, so asserting it proves the component mounted under the shell's real
 * providers.
 */

/**
 * Reach Settings the way a user does.
 *
 * Not `page.goto("/repos/settings")`: manual key entry sets no
 * remembered-device key, so any full navigation drops the session. The
 * palette's own Settings action is a client-side route change, which keeps it.
 */
async function openSettings(page: Page): Promise<void> {
  await openPalette(page);
  await page.getByTestId("search-input").fill("settings");
  await page
    .getByRole("option", { name: /Settings/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/repos\/settings/);
}

test("settings renders the community roster and the presence control", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await signInAndOpenShell(page);
  await openSettings(page);

  const members = page.getByTestId("community-members");
  await expect(members).toBeVisible();
  await expect(members).toContainText("Community members");
  // With no relay the subscription never reaches EOSE, so the card stays in
  // its reading state. That is the honest assertion here: the "this relay
  // publishes no membership list" copy needs a relay that answers, and
  // claiming this test proves it would be claiming more than it checks.
  await expect(members).toContainText(/Reading the membership list/i);

  await expect(page.getByTestId("settings-presence")).toBeVisible();
  await expect(page.getByTestId("presence-status-trigger")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("the presence menu offers active, away and invisible", async ({
  page,
}) => {
  await signInAndOpenShell(page);
  await openSettings(page);
  await page.getByTestId("presence-status-trigger").click();

  for (const status of ["online", "away", "offline"]) {
    await expect(page.getByTestId(`presence-status-${status}`)).toBeVisible();
  }

  await page.getByTestId("presence-status-offline").click();
  // The choice is persisted per pubkey, so the trigger reflects it.
  await expect(page.getByTestId("presence-status-trigger")).toContainText(
    "Invisible",
  );
});

test("the palette opens with its operator hint and closes on Escape", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await signInAndOpenShell(page);
  await openPalette(page);

  const panel = page.getByTestId("search-panel");
  await expect(page.getByTestId("search-input")).toBeFocused();
  // The empty state teaches the operators the panel now understands.
  await expect(panel).toContainText("from:");
  await expect(panel).toContainText("in:");
  await expect(panel).toContainText("after:2025-03-01");

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("the palette keyboard-selects a jump target and opens it", async ({
  page,
}) => {
  await signInAndOpenShell(page);
  await openPalette(page);
  const input = page.getByTestId("search-input");

  // "Settings" is a shell palette action, present without any relay data.
  await input.fill("settings");
  const action = page.getByRole("option", { name: /Settings/ });
  await expect(action).toBeVisible();

  // The listbox is driven from the input, which keeps the caret where the
  // user is typing — the panel had no keyboard navigation at all before this.
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    /search-result-/,
  );
  await expect(action).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  await expect(input).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(action).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/repos\/settings/);
});

test("an unmatched in: filter refuses to search instead of widening", async ({
  page,
}) => {
  await signInAndOpenShell(page);
  await openPalette(page);
  await page.getByTestId("search-input").fill("in:#nowhere deploy");

  // The refusal is the feature: searching everywhere would answer a different
  // question than the one the user asked.
  await expect(page.getByTestId("search-unresolved")).toBeVisible();
  await expect(page.getByTestId("search-unresolved")).toContainText(
    "in:#nowhere",
  );
});

test("the Files action opens the panel dock, which docks a second site", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // A configured Files URL, seeded before the app mounts: the dock reads it
  // through the same per-browser setting the Settings page writes.
  //
  // Guarded, because `addInitScript` runs in EVERY frame — including the
  // cross-origin panel iframes this test then opens, where touching
  // `localStorage` throws SecurityError. Unguarded it reported three page
  // errors that looked like an app fault and were the harness's own.
  await page.addInitScript(() => {
    if (window.top !== window.self) {
      return;
    }
    try {
      window.localStorage.setItem("buzz:files-url", "https://files.invalid/");
    } catch {
      // A frame with no storage access; the top document is what matters.
    }
  });
  await signInAndOpenShell(page);

  // Raised through the palette's Files action rather than the sidebar button,
  // so this spec depends on nothing in features/sidebar.
  await openPalette(page);
  await page.getByTestId("search-input").fill("files");
  await page.getByRole("option", { name: /Files/ }).first().click();

  await expect(page.getByTestId("web-panel-dock")).toBeVisible();
  // The dock opens the first site on its own rather than showing an empty
  // frame under a tab bar.
  await expect(page.getByTestId("web-panel-tabs").getByRole("tab")).toHaveCount(
    1,
  );

  await page.getByTestId("web-panel-add-site").click();
  // A javascript: URL that carries a real HOST. `javascript:alert(1)` would
  // not discriminate: it also has an empty hostname, so the registry's
  // separate hostname check rejects it even with the protocol allowlist
  // removed — measured, by mutating the allowlist and watching this test still
  // pass. This form is stopped only by the allowlist.
  await page
    .getByTestId("add-site-url")
    .fill("javascript://evil.example/%0aalert(1)");
  await page.getByTestId("add-site-submit").click();
  // The URL guard runs in the real UI, not only in the unit test.
  await expect(page.getByTestId("add-site-error")).toContainText(
    /http:\/\/ or https:\/\//,
  );

  await page.getByTestId("add-site-url").fill("notes.invalid");
  await page.getByTestId("add-site-submit").click();
  await expect(page.getByTestId("add-site-dialog")).toBeHidden();

  await page.getByTestId("web-panel-open-custom:1").click();
  await expect(page.getByTestId("web-panel-tabs").getByRole("tab")).toHaveCount(
    2,
  );
  // Both frames stay mounted; only the active one is visible. That is the
  // property a single swappable iframe cannot have.
  await expect(
    page.locator('iframe[data-testid^="web-panel-frame-"]'),
  ).toHaveCount(2);

  expect(pageErrors).toEqual([]);
});
