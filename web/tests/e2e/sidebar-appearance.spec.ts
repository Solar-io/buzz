import { expect, type Page, test } from "@playwright/test";

import { signIn } from "./helpers/signIn";

/**
 * Prominent active tab, measured on the row it claims to repaint.
 *
 * Reading back `data-prominent-active-tab` proves only that a control wrote an
 * attribute. The preference is carried entirely by CSS — no component reads
 * it — so a toggle wired to a store no stylesheet matches would pass an
 * attribute assertion and change nothing on screen. What discriminates is the
 * COMPUTED style of the selected sidebar row, before and after.
 *
 * `?view=inbox` is used because it gives a selected sidebar row with no relay:
 * the Inbox entry is `selected` whenever that view is open, so this needs no
 * channel list and no fixtures.
 */

/** Computed background, shadow and label weight of the selected sidebar row. */
async function activeRowStyle(page: Page): Promise<{
  background: string;
  shadow: string;
  weight: string;
}> {
  // The shell mounts before the sidebar's rows do, and a `goto` back into it
  // resolves the moment the document loads — so wait for the sidebar itself
  // rather than racing the row query against React's first commit.
  const sidebar = page.getByTestId("channel-sidebar");
  await expect(sidebar).toBeVisible();
  const row = sidebar.locator('[data-active="true"]').first();
  await expect(row).toBeVisible();
  return row.evaluate((element) => {
    const style = getComputedStyle(element);
    const label = element.querySelector("span");
    return {
      background: style.backgroundColor,
      shadow: style.boxShadow,
      weight: label ? getComputedStyle(label).fontWeight : "",
    };
  });
}

test("the sidebar's active row is repainted by the prominent active tab preference", async ({
  page,
}) => {
  await signIn(page, "/repos?view=inbox");
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();

  // Default is off, asserted as a literal so a changed default is caught here.
  await expect(page.locator("html")).toHaveAttribute(
    "data-prominent-active-tab",
    "false",
  );
  const off = await activeRowStyle(page);

  await page.goto("/repos/settings");
  const toggle = page.getByTestId("prominent-active-tab-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-prominent-active-tab",
    "true",
  );

  await page.goto("/repos?view=inbox");
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  const on = await activeRowStyle(page);

  // Every one of the three has to be a real value AND different. Asserting
  // only "they differ" would pass if the row lost its background entirely.
  expect(off.background).not.toBe("");
  expect(off.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(on.background).not.toBe("");
  expect(on.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(on.background).not.toBe(off.background);

  expect(off.shadow).toBe("none");
  expect(on.shadow).not.toBe("none");

  expect(off.weight).toBe("400");
  expect(on.weight).toBe("600");
});

test("the preference survives a reload and applies before the first paint", async ({
  page,
}) => {
  await signIn(page, "/repos?view=inbox");
  // Wait for the shell before navigating away: enrolling flips auth state and
  // the gate hands off with its own client-side navigation, so a `goto` fired
  // into that pending navigation can land on a page whose key store never
  // finished restoring — and the gate comes back.
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await page.goto("/repos/settings");
  await page.getByTestId("prominent-active-tab-toggle").click();

  await page.goto("/repos?view=inbox");
  const before = await activeRowStyle(page);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-prominent-active-tab",
    "true",
  );
  const after = await activeRowStyle(page);
  expect(after.background).toBe(before.background);
});

/**
 * The stored value is the desktop client's, character for character, so the
 * two clients describe one preference rather than two that look alike.
 */
test("the choice is stored under the desktop client's own key", async ({
  page,
}) => {
  await signIn(page, "/repos?view=inbox");
  // Wait for the shell before navigating away: enrolling flips auth state and
  // the gate hands off with its own client-side navigation, so a `goto` fired
  // into that pending navigation can land on a page whose key store never
  // finished restoring — and the gate comes back.
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await page.goto("/repos/settings");
  await page.getByTestId("prominent-active-tab-toggle").click();

  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("buzz-prominent-active-tab")),
    )
    .toBe("true");

  await page.getByTestId("prominent-active-tab-toggle").click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("buzz-prominent-active-tab")),
    )
    .toBe("false");
});
