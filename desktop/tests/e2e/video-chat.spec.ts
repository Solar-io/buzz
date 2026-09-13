import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const ALICE_TYLER_CHANNEL_ID = "f48efb06-0c93-5025-aac9-2e646bb6bfa8";

/**
 * The video-chat entry point lives in the inline DM header actions — the
 * bar every agent DM shows by default. A regression here is invisible to
 * every channel-header spec that uses a non-DM channel, because the button
 * only mounts when the DM's other participant is an agent.
 */
test("agent DM header shows the video chat trigger", async ({ page }) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        displayName: "Alice",
        isAgent: true,
      },
    ],
  });

  await page.goto("/");
  await page.getByTestId("channel-alice-tyler").click();

  const videoTrigger = page.getByTestId("video-chat-trigger");
  await expect(videoTrigger).toBeVisible();
  await expect(videoTrigger).toHaveAttribute("aria-label", "Start video chat");

  // A DM with a human participant stays clean.
  await page.getByTestId("channel-bob-tyler").click();
  await expect(page.getByTestId("video-chat-trigger")).toHaveCount(0);

  // Opening the panel points the loopback relay at the agent DM.
  await page.getByTestId("channel-alice-tyler").click();
  await videoTrigger.click();
  await expect(page.getByRole("button", { name: "Start call" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
          (entry) => entry.command === "video_chat_set_target",
        ),
      ),
    )
    .toEqual([
      {
        command: "video_chat_set_target",
        payload: {
          channelId: ALICE_TYLER_CHANNEL_ID,
          agentPubkey: TEST_IDENTITIES.alice.pubkey,
          agentName: null,
        },
      },
    ]);

  // Closing the panel releases the relay target. (Scoped to the header: the
  // sidebar's per-DM close buttons also match an unscoped name query.)
  await page
    .getByTestId("chat-header")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.getByRole("button", { name: "Start call" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
            (entry) => entry.command === "video_chat_clear_target",
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(1);
});

/**
 * The auto-duck setting: on by default, flippable in the panel's settings
 * sheet, and persisted across an app restart (localStorage). This is the
 * user-facing surface of the barge-in toggle — the unit tests cover the
 * gate logic, this covers that the control is reachable and actually wired.
 */
test("auto-duck toggle: on by default, flips off, persists across reload", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        displayName: "Alice",
        isAgent: true,
      },
    ],
  });

  await page.goto("/");
  await page.getByTestId("channel-alice-tyler").click();
  await page.getByTestId("video-chat-trigger").click();
  await expect(page.getByRole("button", { name: "Start call" })).toBeVisible();

  // The panel's own Settings button: a sibling of the "Video chat — …"
  // header text, so sidebar/settings-view buttons cannot collide with it.
  const panelSettingsButton = page
    .getByText(/Video chat — /)
    .locator("xpath=../button");
  await panelSettingsButton.click();
  await page.screenshot({ path: "logs/auto-duck-settings-sheet.png", fullPage: false });

  const autoDuckSwitch = page.locator("#video-chat-auto-duck-switch");
  await expect(autoDuckSwitch).toBeChecked();

  // Flipping it off persists through the panel's update().
  await autoDuckSwitch.click();
  await expect(autoDuckSwitch).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem("buzz.videoChat.config.v1");
        return raw ? (JSON.parse(raw).autoDuck as boolean) : undefined;
      }),
    )
    .toBe(false);

  // Reload simulates an app restart: the off state must survive.
  await page.reload();
  await page.getByTestId("channel-alice-tyler").click();
  await page.getByTestId("video-chat-trigger").click();
  await expect(page.getByRole("button", { name: "Start call" })).toBeVisible();
  await page
    .getByText(/Video chat — /)
    .locator("xpath=../button")
    .click();
  const reloadedSwitch = page.locator("#video-chat-auto-duck-switch");
  await expect(reloadedSwitch).not.toBeChecked();

  // Restore the default for anything sharing this browser profile.
  await reloadedSwitch.click();
  await expect(reloadedSwitch).toBeChecked();
});
