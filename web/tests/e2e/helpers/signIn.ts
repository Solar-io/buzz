import { expect, type Page } from "@playwright/test";
import { generateSecretKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";

/**
 * Enroll a fresh key through the manual-entry form — the real path.
 *
 * Sign in AT the target URL rather than signing in and then navigating:
 * manual entry does not set the remembered-device key, so a reload drops
 * straight back to the gate. The enrolled shell mounts at whatever URL the
 * gate was showing on.
 *
 * Lifted verbatim from `shell-views.spec.ts`, which keeps its own copy — this
 * file exists so a second spec can reuse it without editing that one.
 *
 * NOTE: the gate lives on `/repos` only. `/repos/settings` renders its page
 * with no gate at all, so signing in "at" that path finds no form. Use
 * {@link signInAndOpenShell} and navigate inside the app instead.
 */
export async function signIn(page: Page, path = "/repos"): Promise<void> {
  await page.goto(path);
  await page.getByRole("button", { name: "Enter key manually" }).click();
  await page.getByPlaceholder("nsec1…").fill(nsecEncode(generateSecretKey()));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("New passphrase").fill("e2e-passphrase");
  await page.getByPlaceholder("Confirm passphrase").fill("e2e-passphrase");
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(
    page.getByRole("button", { name: "Enter key manually" }),
  ).toBeHidden();
}

/**
 * Sign in and wait for the shell itself.
 *
 * The gate disappearing is not the same event as the shell being interactive:
 * its global ⌘K listener is attached by an effect that runs after the shell
 * mounts, so a keystroke sent between the two is delivered to nothing and the
 * palette never opens. Waiting for the sidebar is the real synchronization
 * point — measured, not guessed: pressing ⌘K immediately failed every run,
 * and pressing it after the sidebar appeared passed every run.
 */
export async function signInAndOpenShell(page: Page): Promise<void> {
  await signIn(page, "/repos");
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
}

/**
 * Open the command palette from the shell.
 *
 * `ControlOrMeta` so this reads the same on the macOS dev box and the Linux
 * CI runner; the shell accepts either modifier.
 */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("search-panel")).toBeVisible();
}
