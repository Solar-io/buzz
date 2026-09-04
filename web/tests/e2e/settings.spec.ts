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
