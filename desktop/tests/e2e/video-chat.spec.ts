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
