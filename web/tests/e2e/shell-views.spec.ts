import { expect, type Page, test } from "@playwright/test";
import { generateSecretKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";

/**
 * The shell's `?view=` panes, driven through the real sign-in flow.
 *
 * These panes are the one thing no unit test can vouch for. Each was built to
 * work in isolation and each is imported by exactly one place — the shell —
 * so a pane that is correct but never rendered looks identical to a pane that
 * works, right up until someone opens it. That is the "shipped and dead" hole,
 * and only loading the real page closes it.
 *
 * No relay is running here, and that is deliberate rather than a limitation:
 * every pane's empty state is what a signed-in viewer sees before any data
 * arrives, so asserting it proves the pane mounted and rendered under the
 * shell's providers. What each pane does with real events was verified against
 * the live dev relay when it was built.
 */

/**
 * Enroll a fresh key through the manual-entry form — the real path.
 *
 * Sign in AT the target URL rather than signing in and then navigating:
 * manual entry does not set the remembered-device key, so a reload drops
 * straight back to the gate. The enrolled shell mounts at whatever URL the
 * gate was showing on.
 */
async function signIn(page: Page, path = "/repos"): Promise<void> {
  await page.goto(path);
  await page.getByRole("button", { name: "Enter key manually" }).click();
  await page.getByPlaceholder("nsec1…").fill(nsecEncode(generateSecretKey()));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("New passphrase").fill("e2e-passphrase");
  await page.getByPlaceholder("Confirm passphrase").fill("e2e-passphrase");
  await page.getByRole("button", { name: "Finish" }).click();
  // The gate is gone once the key is unlocked.
  await expect(
    page.getByRole("button", { name: "Enter key manually" }),
  ).toBeHidden();
}

const PANES = [
  { view: "inbox", testId: "home-inbox" },
  { view: "pulse", testId: "pulse-screen" },
  { view: "reminders", testId: "reminders-panel" },
  { view: "projects", testId: "projects-page" },
  { view: "workflows", testId: "workflows-page" },
  { view: "onboarding", testId: "onboarding-pane" },
] as const;

for (const pane of PANES) {
  test(`?view=${pane.view} renders its pane inside the shell`, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await signIn(page, `/repos?view=${pane.view}`);

    await expect(page.getByTestId(pane.testId)).toBeVisible();
    // The sidebar must survive: these are views of the shell, not routes, and
    // the panes read the channel list the shell subscribes to.
    await expect(page.getByTestId("channel-sidebar")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

test("an unknown view falls back to the channel shell, not a blank pane", async ({
  page,
}) => {
  await signIn(page, "/repos?view=not-a-real-view");
  // validateSearch drops anything outside SHELL_VIEWS, so the shell renders
  // its ordinary content rather than an empty slot.
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  for (const pane of PANES) {
    await expect(page.getByTestId(pane.testId)).toHaveCount(0);
  }
});

test("every pane is reachable from the profile menu", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /Open your menu/ }).click();
  for (const label of ["Projects", "Pulse", "Reminders", "Workflows"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
});
