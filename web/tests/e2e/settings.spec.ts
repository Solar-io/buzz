import { expect, type Page, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt as nip49Encrypt } from "nostr-tools/nip49";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";

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
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await page.goto(path);
  return getPublicKey(secretKey);
}

test("every settings card renders for a signed-in viewer", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await signIn(page);

  for (const testId of [
    "welcome-checklist",
    "key-backup-card",
    "identity-archive-card",
    "invites-card",
    "keyboard-shortcuts-card",
    "experiments-card",
    "appearance-card",
    "custom-emoji-card",
  ]) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }
  expect(pageErrors).toEqual([]);
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
  await signIn(page);
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

test("a short backup passphrase is refused and a long one is accepted", async ({
  page,
}) => {
  await signIn(page);
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
  await signIn(page);
  await expect(page.getByTestId("channel-templates-card")).toHaveCount(0);

  await page.getByTestId("feature-toggle-channel-templates").click();
  await expect(page.getByTestId("channel-templates-card")).toBeVisible();

  // And the choice survives a reload, because it is persisted.
  await page.reload();
  await expect(page.getByTestId("channel-templates-card")).toBeVisible();
});

test("a channel template can be created and persists across a reload", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("feature-toggle-channel-templates").click();

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

  await page.goto("/repos/settings");
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
  await signIn(page);
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
  await signIn(page);
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

test("link preview and thread layout choices persist across a reload", async ({
  page,
}) => {
  await signIn(page);

  // Defaults, asserted as literals so a changed default is caught here.
  await expect(page.locator("html")).toHaveAttribute(
    "data-link-preview-style",
    "compact",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-thread-layout",
    "split",
  );

  await page.getByTestId("link-preview-style-rich").check();
  await page.getByTestId("thread-layout-focus").check();
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute(
    "data-link-preview-style",
    "rich",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-thread-layout",
    "focus",
  );
});

test("the accent picker repaints the interface's primary colour", async ({
  page,
}) => {
  await signIn(page);
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

test("the custom emoji card offers add, and refuses an illegal name", async ({
  page,
}) => {
  await signIn(page);
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
