import { expect, type Page, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt as nip49Encrypt } from "nostr-tools/nip49";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { readFileSync } from "node:fs";

/**
 * The settings surface, driven through the real sign-in flow.
 *
 * These cards are each imported by exactly one place — the settings page — so
 * a card that is correct but never rendered looks identical to one that works,
 * right up until someone opens Settings. Unit tests cannot see that, and this
 * is the file that can.
 *
 * It also pins the one bug this surface has already had: `activeSignerSource()`
 * is a plain read of module state that the key store fills in ASYNCHRONOUSLY,
 * so a component that samples it once at mount reports "extension" forever on
 * a device whose key is sitting in IndexedDB. That shipped, looked healthy, and
 * silently removed the "back up your key" item for exactly the people who
 * needed it. `the key backup card offers a backup for a local key` is the
 * regression guard.
 */

const BACKUP_PASSPHRASE = "a-good-backup-passphrase";

/**
 * Enroll a fresh key through the manual-entry form — the real path — and
 * return the pubkey it produced.
 *
 * Unlike the shell-views helper, this one DOES navigate afterwards, because
 * settings is a separate route. `enrollSecretKey` writes a remembered-device
 * key, so the enrolled identity survives that navigation; what does not
 * survive is navigating too early, hence the wait for the shell below.
 */
async function signIn(page: Page, path = "/repos/settings"): Promise<string> {
  const secretKey = generateSecretKey();
  await page.goto("/repos");
  await page.getByRole("button", { name: "Enter key manually" }).click();
  await page
    .getByPlaceholder("nsec1… or ncryptsec1…")
    .fill(nsecEncode(secretKey));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("New passphrase").fill("e2e-passphrase");
  await page.getByPlaceholder("Confirm passphrase").fill("e2e-passphrase");
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(
    page.getByRole("button", { name: "Enter key manually" }),
  ).toBeHidden();
  // Wait for the shell the gate hands off to before navigating away. Enrolling
  // flips auth state, which makes LoginPage kick off its own client-side
  // navigation to /repos; a `goto` fired into that pending navigation races it,
  // and the losing order lands on a settings page whose key store never
  // finished restoring.
  // A phone lands on the Channels tab with the tab bar (Channels | Work |
  // More); wider viewports show the docked channel rail.
  const shellReady =
    (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) < 768
      ? page.getByTestId("phone-tab-bar")
      : page.getByTestId("channel-sidebar");
  await expect(shellReady).toBeVisible();
  await page.goto(path);
  return getPublicKey(secretKey);
}

/**
 * Settings is two panes since the 2026-09-20 redesign: a nav of nine groups
 * and one content pane, the group carried in `?group=` (Account is the
 * paramless default). Each card renders in exactly one group.
 */
const settingsPath = (group: string) => `/repos/settings?group=${group}`;

test("every settings card renders for a signed-in viewer", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await signIn(page);

  // Walk the groups through the nav itself, so a group whose nav item or
  // pane is not wired up fails here rather than only on a deep link.
  const nav = page.getByRole("navigation", { name: "Settings" });
  for (const [navItem, group, testIds] of [
    [/^Account/, "account", ["welcome-checklist-strip"]],
    [/^Appearance/, "appearance", ["appearance-card"]],
    [/^Keyboard shortcuts/, "keyboard", ["keyboard-shortcuts-card"]],
    [/^Community/, "community", ["invites-card", "custom-emoji-card"]],
    [
      /^Security & devices/,
      "security",
      ["key-backup-card", "identity-archive-card"],
    ],
    [/^Advanced/, "advanced", ["experiments-card"]],
  ] as const) {
    await nav.getByRole("button", { name: navItem }).click();
    await expect(page.getByTestId(`settings-pane-${group}`)).toBeVisible();
    for (const testId of testIds) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
  }
  expect(pageErrors).toEqual([]);
});

test.describe("narrow mobile settings layout", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("keeps the header visible at the bottom and returns to channels", async ({
    page,
  }) => {
    await signIn(page);

    const header = page.getByTestId("settings-header");
    // Below md the nav rail (and its `settings-back`) is hidden; the narrow
    // header carries its own Back link (two-pane redesign, be0a5fad6).
    await expect(page.getByTestId("settings-back")).toBeHidden();
    const back = header.getByRole("link", { name: "← Back" });
    const scroller = page.getByTestId("settings-scroll");
    await expect(header).toBeVisible();
    await expect(back).toBeVisible();

    const scrollHeight = await scroller.evaluate((element) => {
      return element.scrollHeight;
    });
    const clientHeight = await scroller.evaluate((element) => {
      return element.clientHeight;
    });
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const maxScrollTop = scrollHeight - clientHeight;
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(maxScrollTop);

    await expect(header).toBeVisible();
    await expect(back).toBeVisible();
    const viewportHeight = page.viewportSize()?.height ?? 667;
    for (const element of [header, back]) {
      const box = await element.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
        viewportHeight,
      );
    }

    await back.click();
    await expect(page).toHaveURL(/\/repos(?:\?.*)?$/);
    await expect(
      page
        .getByTestId("phone-tab-bar")
        .getByRole("button", { name: /Channels/ }),
    ).toBeVisible();
  });
});

/**
 * The regression guard for the async-signer bug. A local key must produce the
 * backup-offering branch, NOT the "you use an extension" branch — and the
 * distinction only appears after the key store has restored, which is the
 * whole point.
 */
test("the key backup card offers a backup for a local key", async ({
  page,
}) => {
  await signIn(page, settingsPath("security"));
  const card = page.getByTestId("key-backup-card");
  await expect(card).toContainText("Your key exists only in this browser");
  await expect(card.locator("#backup-pass")).toBeVisible();
  await expect(card).not.toContainText("signing with a browser extension");
});

/** The same bug, seen from the checklist: the critical item must be listed. */
test("the setup checklist lists the key backup for a local key", async ({
  page,
}) => {
  await signIn(page);
  // Settings' Account pane carries the checklist as a strip: the backup chip
  // is there, unfinished (no strike-through), and leads to Security.
  const chip = page.getByTestId("checklist-chip-backup");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".line-through")).toHaveCount(0);
  await expect(page.getByTestId("welcome-checklist-strip")).toContainText(
    "One of these protects your identity",
  );
  await chip.click();
  await expect(page.getByTestId("settings-pane-security")).toBeVisible();

  // The full checklist — explanations and calls to action — is the shell's
  // onboarding pane.
  await page.goto("/repos?view=onboarding");
  const item = page.getByTestId("checklist-item-backup");
  await expect(item).toBeVisible();
  // Unfinished, so it still shows its explanation and its call to action. The
  // total is deliberately not asserted: "decide about notifications" ticks
  // itself in a headless browser, where the permission is already "denied"
  // rather than "default", so a hardcoded count would pass or fail on the
  // runner rather than on the code.
  await expect(item).toContainText("Your key lives in this browser's storage");
  await expect(
    item.getByRole("link", { name: "Create a backup" }),
  ).toBeVisible();
  await expect(page.getByTestId("welcome-checklist")).toContainText(
    "one of these protects your identity",
  );
});

/**
 * A pairing QR is refused from an origin another device cannot reach
 * (loopback, `.local`, plain http — 72d8ac3de), and the preview server is
 * exactly that. So the QR half is driven from a stand-in tailnet origin,
 * `https://pair.test`, whose requests are answered by the preview server.
 * Service workers are blocked there: a worker's own fetches skip
 * `page.route`, and the stand-in host resolves nowhere.
 */
const PREVIEW_ORIGIN = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4173}`;

test("a pairing QR is refused from a loopback origin", async ({ page }) => {
  await signIn(page, settingsPath("security"));
  const card = page.getByTestId("pair-device-card");
  await card.getByRole("button", { name: "Show pairing QR" }).click();
  await expect(
    page.getByText(/Cannot create a pairing QR from http:\/\/127\.0\.0\.1/),
  ).toBeVisible();
  await expect(card.getByRole("img")).toHaveCount(0);
});

test.describe("pairing from a reachable origin", () => {
  test.use({ baseURL: "https://pair.test", serviceWorkers: "block" });
  test.beforeEach(async ({ page }) => {
    await page.route("https://pair.test/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: `${PREVIEW_ORIGIN}${url.pathname}${url.search}`,
      });
      await route.fulfill({ response });
    });
  });

  test("pairing instructions keep iPhone scans inside the native app", async ({
    page,
  }) => {
    await pairingInstructions(page);
  });
});

async function pairingInstructions(page: Page): Promise<void> {
  await signIn(page, settingsPath("security"));

  const card = page.getByTestId("pair-device-card");
  const instructions = card.getByTestId("pairing-instructions");
  await expect(instructions).toContainText("native Buzz Web app");
  await expect(instructions).toContainText("Pair with QR code");
  await expect(instructions).toContainText("in-app camera");
  await expect(instructions).toContainText(
    "Do not use the system Camera or Safari",
  );
  await expect(
    card.getByRole("button", { name: "Show pairing QR" }),
  ).toBeVisible();

  await card.getByRole("button", { name: "Show pairing QR" }).click();
  await expect(
    card.getByRole("img", { name: "Device pairing QR code" }),
  ).toBeVisible();
  await expect(instructions).toBeVisible();
  await expect(card.getByTestId("pairing-qr-ready")).toContainText(
    "Buzz Web's in-app camera",
  );
}

test("a short backup passphrase is refused and a long one is accepted", async ({
  page,
}) => {
  await signIn(page, settingsPath("security"));
  const card = page.getByTestId("key-backup-card");
  await card.locator("#backup-pass").fill("short");
  await expect(card).toContainText("Use at least 12 characters");
  await card.locator("#backup-pass").fill(BACKUP_PASSPHRASE);
  await expect(card).not.toContainText("Use at least 12 characters");
});

/**
 * The experiments gate must actually gate something. Off ⇒ the channel
 * templates card is absent; on ⇒ it renders. A toggle that changed nothing
 * would pass a "the switch flips" assertion and fail this one.
 */
test("the experiments switch reveals the channel templates card", async ({
  page,
}) => {
  // The switch lives in Advanced; the card it gates lives in Community.
  await signIn(page, settingsPath("community"));
  await expect(page.getByTestId("settings-pane-community")).toBeVisible();
  await expect(page.getByTestId("custom-emoji-card")).toBeVisible();
  await expect(page.getByTestId("channel-templates-card")).toHaveCount(0);

  await page.goto(settingsPath("advanced"));
  await page.getByTestId("feature-toggle-channel-templates").click();
  await page.goto(settingsPath("community"));
  await expect(page.getByTestId("channel-templates-card")).toBeVisible();

  // And the choice survives a reload, because it is persisted.
  await page.reload();
  await expect(page.getByTestId("channel-templates-card")).toBeVisible();
});

test("a channel template can be created and persists across a reload", async ({
  page,
}) => {
  await signIn(page, settingsPath("advanced"));
  await page.getByTestId("feature-toggle-channel-templates").click();
  await page.goto(settingsPath("community"));

  const card = page.getByTestId("channel-templates-card");
  await expect(card).toContainText("No templates yet");
  await card.getByRole("button", { name: "New template" }).click();

  await page.getByRole("textbox", { name: "Name" }).fill("Design Review");
  await page.getByLabel("Channel type").selectOption("forum");
  await page.getByLabel("Visibility").selectOption("private");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  // The dialog closes only after the IndexedDB write resolves, so its
  // disappearance — not the row appearing — is the signal that the template is
  // durable. The row is painted from the in-memory mirror first, so reloading
  // on that alone races the write.
  await expect(page.getByRole("dialog")).toBeHidden();

  const row = page.locator('[data-testid^="channel-template-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Design Review");
  await expect(row).toContainText("Forum");
  await expect(row).toContainText("Private");

  await page.reload();
  await expect(
    page.locator('[data-testid^="channel-template-"]'),
  ).toContainText("Design Review");
});

/**
 * Restoring from a NIP-49 backup, end to end through the gate.
 *
 * The assertion that matters is the LAST one: the restored session must be the
 * identity the backup was made from. Asserting only "we got past the gate"
 * would pass for any key at all.
 */
test("an encrypted backup restores the identity it was made from", async ({
  page,
}) => {
  const secretKey = generateSecretKey();
  const expectedNpub = npubEncode(getPublicKey(secretKey));
  const blob = nip49Encrypt(secretKey, BACKUP_PASSPHRASE, 16);

  await page.goto("/repos");
  await page.getByRole("button", { name: "Enter key manually" }).click();
  await page.getByPlaceholder("nsec1… or ncryptsec1…").fill(blob);

  // The form recognises a backup and asks for its passphrase.
  await expect(page.getByPlaceholder("Backup passphrase")).toBeVisible();

  // A wrong passphrase must not get in.
  await page.getByPlaceholder("Backup passphrase").fill("not-the-passphrase");
  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(page.getByPlaceholder("Backup passphrase")).toBeVisible();

  await page.getByPlaceholder("Backup passphrase").fill(BACKUP_PASSPHRASE);
  await page.getByRole("button", { name: "Open backup" }).click();
  await page.getByPlaceholder("New passphrase").fill("e2e-passphrase");
  await page.getByPlaceholder("Confirm passphrase").fill("e2e-passphrase");
  await page.getByRole("button", { name: "Finish" }).click();
  // Same hand-off race as `signIn`: wait for the shell before navigating.
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();

  await page.goto(settingsPath("security"));
  await expect(page.getByText(expectedNpub)).toBeVisible();
});

/**
 * Appearance preferences — the checks that would catch a control which looks
 * right and changes nothing.
 *
 * Reading back the root attribute is not enough on its own: an attribute is
 * only a claim about intent. So the font-size test MEASURES the rendered type
 * of the same `text-message` token real message rows use, and asserts the
 * 13 / 14 / 15px contract this repo's CLAUDE.md pins. A control wired to a
 * store that no stylesheet reads passes the attribute assertion and fails
 * this one.
 */
const conversationFontSize = (page: Page) =>
  page
    .getByTestId("conversation-preview-body")
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize);

test("font size drives the real conversation type scale, 13 / 14 / 15px", async ({
  page,
}) => {
  await signIn(page, settingsPath("appearance"));
  const card = page.getByTestId("appearance-card");
  await expect(card).toBeVisible();

  // Default first, so the other two are compared against a known baseline
  // rather than against whatever the browser happened to start with.
  await expect(conversationFontSize(page)).resolves.toBe("14px");

  await page.getByTestId("font-size-smaller").check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-font-size",
    "smaller",
  );
  await expect(conversationFontSize(page)).resolves.toBe("13px");

  await page.getByTestId("font-size-larger").check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-font-size",
    "larger",
  );
  await expect(conversationFontSize(page)).resolves.toBe("15px");

  // Persisted, and applied before first paint on the next load.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-font-size",
    "larger",
  );
  await expect(conversationFontSize(page)).resolves.toBe("15px");
});

test("conversation density changes real conversation spacing", async ({
  page,
}) => {
  await signIn(page, settingsPath("appearance"));
  const rowPadding = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--conversation-row-padding-block")
        .trim(),
    );

  await page.getByTestId("conversation-density-spacious").check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-conversation-density",
    "spacious",
  );
  const spacious = await rowPadding();

  await page.getByTestId("conversation-density-compact").check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-conversation-density",
    "compact",
  );
  const compact = await rowPadding();

  // Both must be real values AND different — equal-on-both-sides would pass a
  // stylesheet that declared the attribute and changed nothing.
  expect(spacious).not.toBe("");
  expect(compact).not.toBe("");
  expect(spacious).not.toBe(compact);
});

test("the link preview choice persists across a reload", async ({ page }) => {
  await signIn(page, settingsPath("appearance"));

  // Defaults, asserted as literals so a changed default is caught here.
  await expect(page.locator("html")).toHaveAttribute(
    "data-link-preview-style",
    "compact",
  );

  await page.getByTestId("link-preview-style-rich").check();
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute(
    "data-link-preview-style",
    "rich",
  );
  // The Thread layout setting left with the thread pane: threads open inline.
  await expect(page.getByTestId("thread-layout-row")).toHaveCount(0);
});

test("the accent picker repaints the interface's primary colour", async ({
  page,
}) => {
  await signIn(page, settingsPath("appearance"));
  const primary = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--primary")
        .trim(),
    );

  const themeDefault = await primary();
  await page.getByTestId("accent-color-green").click();
  const green = await primary();
  await page.getByTestId("accent-color-red").click();
  const red = await primary();

  // Three distinct values. Asserting only "green !== default" would pass an
  // implementation that wrote one hardcoded accent for every swatch.
  expect(new Set([themeDefault, green, red]).size).toBe(3);

  // And "theme default" must REMOVE the override rather than write another
  // colour, or the stylesheet's own values could never come back.
  await page.getByTestId("accent-color-theme-default").click();
  await expect(primary()).resolves.toBe(themeDefault);
});

test("Custom Gradient is one picker choice with live, persistent variables and cleanup", async ({
  page,
}) => {
  await signIn(page, settingsPath("appearance"));
  const picker = page.locator("#appearance-theme");
  await expect(picker.locator('option[value="custom-gradient"]')).toHaveCount(
    1,
  );
  await expect(picker.locator('option[value^="custom-gradient-"]')).toHaveCount(
    0,
  );
  await picker.selectOption("custom-gradient");
  const editor = page.getByRole("group", { name: "Custom Gradient" });
  await expect(editor.locator('input[type="color"]')).toHaveCount(4);
  await expect(editor.locator('input[type="range"]')).toHaveCount(1);

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-custom-gradient", "true");
  await page.getByLabel("Gradient color 1").fill("#f1e2d3");
  await page.getByLabel("Gradient color 2").fill("#102030");
  await page.getByLabel("Light content color").fill("#fffefe");
  await page.getByLabel("Dark content color").fill("#121212");
  await page.locator("#gradient-midpoint").fill("73");
  await expect(page.locator("#gradient-midpoint")).toHaveAttribute(
    "aria-valuetext",
    "73 percent",
  );
  await expect(root).toHaveCSS("--custom-gradient-color-1", "#f1e2d3");
  await expect(root).toHaveCSS("--custom-gradient-color-2", "#102030");
  await expect(root).toHaveCSS("--custom-gradient-midpoint", "73%");
  const metaColors = await page
    .locator('meta[name="theme-color"]')
    .evaluateAll((metas) => metas.map((meta) => meta.getAttribute("content")));
  expect(metaColors).toContain("#fffefe");
  expect(metaColors).toContain("#121212");
  expect(metaColors).not.toContain("#f1e2d3");
  expect(metaColors).not.toContain("#102030");

  await page.reload();
  await expect(picker).toHaveValue("custom-gradient");
  await expect(root).toHaveAttribute("data-custom-gradient", "true");
  await expect(page.locator("#gradient-midpoint")).toHaveValue("73");
  if (process.env.CAPTURE_CUSTOM_GRADIENT === "1") {
    await page
      .getByRole("group", { name: "Custom Gradient" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("custom-gradient-settings.png"),
    });
  }

  await picker.selectOption("github-light");
  await expect(root).not.toHaveAttribute("data-custom-gradient", /.+/);
  await expect(root).toHaveCSS("--custom-gradient-content", "");
  await expect(root).toHaveCSS("--custom-gradient-light", "");
  await expect(root).toHaveCSS("--custom-gradient-dark", "");
  await expect(root).toHaveCSS("--custom-gradient-pane", "");
  await expect(root).toHaveCSS("--custom-gradient-pane-hsl", "");
  for (const meta of await page.locator('meta[name="theme-color"]').all()) {
    await expect(meta).not.toHaveAttribute("content", "#fffefe");
  }

  await picker.selectOption("custom-gradient");
  await page.getByTestId("color-mode-dark").check();
  await expect(root).toHaveCSS("--custom-gradient-content", "#121212");
  await picker.selectOption("github-dark");
  await expect(root).not.toHaveAttribute("data-custom-gradient", /.+/);
  for (const meta of await page.locator('meta[name="theme-color"]').all()) {
    await expect(meta).not.toHaveAttribute("content", "#121212");
  }
});

test("Custom Gradient migrates v1 once without changing the v1 record", async ({
  page,
}) => {
  const v1 = JSON.stringify({
    version: 1,
    lightColor: "#aabbcc",
    darkColor: "#112233",
    midpoint: 37,
  });
  await page.addInitScript((stored) => {
    localStorage.setItem("buzz-custom-gradient-v1", stored);
    localStorage.removeItem("buzz-custom-gradient-v2");
  }, v1);
  await signIn(page, settingsPath("appearance"));
  expect(
    await page.evaluate(() => localStorage.getItem("buzz-custom-gradient-v1")),
  ).toBe(v1);
  expect(
    JSON.parse(
      (await page.evaluate(() =>
        localStorage.getItem("buzz-custom-gradient-v2"),
      )) ?? "null",
    ),
  ).toEqual({
    version: 2,
    gradientColor1: "#aabbcc",
    gradientColor2: "#112233",
    midpoint: 37,
    lightContentColor: "#aabbcc",
    darkContentColor: "#112233",
  });
});

test("Custom Gradient pane endpoint follows Light, Dark, and System mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signIn(page, settingsPath("appearance"));
  await page.locator("#appearance-theme").selectOption("custom-gradient");
  await page.getByLabel("Gradient color 1").fill("#ffeeaa");
  await page.getByLabel("Gradient color 2").fill("#88ccdd");
  await page.getByLabel("Light content color").fill("#f0e0d0");
  await page.getByLabel("Dark content color").fill("#102030");
  const root = page.locator("html");
  const gradientBefore = await root.evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      "--custom-gradient-color-1",
      "--custom-gradient-color-2",
      "--custom-gradient-midpoint",
      "--custom-gradient-mix",
    ].map((name) => style.getPropertyValue(name));
  });

  await page.getByTestId("color-mode-light").check();
  await expect(root).toHaveCSS("--custom-gradient-content", "#f0e0d0");
  await page.getByTestId("color-mode-dark").check();
  await expect(root).toHaveCSS("--custom-gradient-content", "#102030");
  expect(
    await root.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        "--custom-gradient-color-1",
        "--custom-gradient-color-2",
        "--custom-gradient-midpoint",
        "--custom-gradient-mix",
      ].map((name) => style.getPropertyValue(name));
    }),
  ).toEqual(gradientBefore);

  await page.getByTestId("color-mode-system").check();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveCSS("--custom-gradient-content", "#f0e0d0");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveCSS("--custom-gradient-content", "#102030");
});

test("Custom Gradient paints one shell ramp with frosted navigation and inset panes", async ({
  page,
}, testInfo) => {
  await signIn(page, settingsPath("appearance"));
  await page.locator("#appearance-theme").selectOption("custom-gradient");
  await page.getByLabel("Gradient color 1").fill("#f2ecb5");
  await page.getByLabel("Gradient color 2").fill("#8fcfe3");
  await page.getByLabel("Light content color").fill("#ffffff");
  await page.getByLabel("Dark content color").fill("#17132f");
  await page.getByTestId("color-mode-light").check();
  await page.evaluate(() => {
    let shell = document.querySelector(".buzz-app-shell");
    if (!shell) {
      shell = document.createElement("div");
      shell.className = "buzz-app-shell fixed inset-0 z-[100] flex";
      const nav = document.createElement("aside");
      nav.className = "buzz-shell-navigation w-64 p-5";
      nav.textContent = "Buzz\nChannels\nGeneral\nDirect messages";
      shell.append(nav);
      document.body.append(shell);
    }
    const row = document.createElement("div");
    row.className = "buzz-conversation-row flex min-w-0 flex-1";
    const chat = document.createElement("section");
    chat.className = "buzz-conversation-pane min-w-0 flex-1 p-6";
    chat.dataset.customContentPane = "chat";
    chat.textContent =
      "Chat\nOne continuous gradient frames this solid conversation surface.";
    const separator = document.createElement("div");
    separator.className =
      "buzz-side-panel-resize-handle hidden w-1 shrink-0 lg:block lg:-ml-px";
    const replies = document.createElement("aside");
    replies.dataset.customContentPane = "replies";
    replies.className = "w-64 p-6";
    replies.textContent =
      "Replies\nThread replies use the same content surface.";
    const thinking = document.createElement("aside");
    thinking.dataset.customContentPane = "thinking";
    thinking.dataset.thinkingPane = "";
    thinking.className = "w-80 p-6";
    thinking.textContent =
      "Thinking\nA distinct inset surface, without a bright divider.";
    row.append(chat, separator, replies, thinking);
    shell.append(row);
  });

  const shell = page.locator(".buzz-app-shell");
  const nav = page.locator(".buzz-shell-navigation").first();
  const row = page.locator(".buzz-conversation-row");
  const chat = page.locator(".buzz-conversation-pane");
  const thinking = page.locator("[data-thinking-pane]");
  const replies = page.locator('[data-custom-content-pane="replies"]');
  const separator = page.locator(".buzz-side-panel-resize-handle");
  await expect(shell).toHaveCSS("background-image", /linear-gradient/);
  const shellImage = await shell.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  expect(shellImage).toContain("rgb(242, 236, 181)");
  expect(shellImage).toContain("rgb(143, 207, 227)");
  expect(shellImage).not.toContain("rgb(255, 255, 255)");
  await expect(nav).toHaveCSS("background-image", "none");
  await expect(nav).toHaveCSS("backdrop-filter", /blur\(24px\)/);
  expect(
    await nav.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toMatch(/rgba\(.+, 0\.[0-9]+\)/);
  await expect(row).toHaveCSS("gap", "0px");
  await expect(separator).toHaveCSS("width", "8px");
  await expect(chat).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(replies).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(thinking).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(chat).toHaveCSS("border-radius", "12px");
  await expect(thinking).toHaveCSS("border-left-width", "1px");
  const chatBox = await chat.boundingBox();
  const repliesBox = await replies.boundingBox();
  expect(
    (repliesBox?.x ?? 0) - ((chatBox?.x ?? 0) + (chatBox?.width ?? 0)),
  ).toBe(8);
  expect(
    await chat.evaluate((el) => {
      const style = getComputedStyle(el);
      return (
        style.getPropertyValue("--border") !==
        style.getPropertyValue("--foreground")
      );
    }),
  ).toBe(true);
  const sourceRoot = new URL("../../src/", import.meta.url);
  for (const [file, marker] of [
    ["app/routes/repos.tsx", 'data-custom-content-pane="chat"'],
    // The thread panel is gone (threads open inline since redesign phase 2);
    // the right dock's other pane is Work.
    ["features/work/ui/WorkTab.tsx", 'data-custom-content-pane="work"'],
    [
      "features/agents/ui/AgentActivityPanel.tsx",
      'data-custom-content-pane="thinking"',
    ],
  ]) {
    expect(readFileSync(new URL(file, sourceRoot), "utf8")).toContain(marker);
  }
  if (process.env.CAPTURE_CUSTOM_GRADIENT === "1") {
    await page.screenshot({
      path: testInfo.outputPath("custom-gradient-desktop.png"),
    });
  }
});

test.describe("Custom Gradient on a phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("has no horizontal overflow and keeps controls at touch size", async ({
    page,
  }, testInfo) => {
    await signIn(page, settingsPath("appearance"));
    await page.locator("#appearance-theme").selectOption("custom-gradient");
    const scroller = page.getByTestId("settings-scroll");
    expect(
      await scroller.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const modeCopy = page.getByText("System follows your device", {
      exact: false,
    });
    const modeCopyBox = await modeCopy.boundingBox();
    const modeControlBox = await page
      .getByTestId("color-mode-control")
      .boundingBox();
    expect(modeCopyBox?.width ?? 0).toBeGreaterThanOrEqual(250);
    expect(modeControlBox?.y ?? 0).toBeGreaterThanOrEqual(
      (modeCopyBox?.y ?? 0) + (modeCopyBox?.height ?? 0),
    );
    for (const control of [
      page.getByLabel("Gradient color 1"),
      page.getByLabel("Gradient color 2"),
      page.getByLabel("Light content color"),
      page.getByLabel("Dark content color"),
      page.locator("#gradient-midpoint"),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    if (process.env.CAPTURE_CUSTOM_GRADIENT === "1") {
      await page
        .getByRole("group", { name: "Custom Gradient" })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath("custom-gradient-phone.png"),
      });
    }
  });
});

test("the custom emoji card offers add, and refuses an illegal name", async ({
  page,
}) => {
  await signIn(page, settingsPath("community"));
  const card = page.getByTestId("custom-emoji-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("My emoji");

  const add = card.getByTestId("custom-emoji-add");
  // Nothing uploaded yet, so there is nothing to save.
  await expect(add).toBeDisabled();

  await card.getByTestId("custom-emoji-name-input").fill("not a name");
  await expect(card).toContainText("Use only letters, numbers");
  await expect(add).toBeDisabled();
});
