import { expect, test } from "@playwright/test";

import { installMockBridge, openNewMessagePage, TEST_IDENTITIES } from "../helpers/bridge";

// #random has no default mock relay agents (alice covers general + agents),
// so the only session-agent candidate is the one this spec seeds.
const RANDOM_CHANNEL_ID = "9dae0116-799b-5071-a0a8-fdd30a91a35d";

const activityButton = (page: import("@playwright/test").Page) =>
  page.getByTestId("open-agent-activity");

test.describe("header agent-activity button", () => {
  test("channel: renders left of Buzz Term and opens the session pane", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: TEST_IDENTITIES.tyler.pubkey,
          name: "Observer Agent",
          status: "running" as const,
          channelNames: ["random"],
        },
      ],
    });

    await page.goto(`/#/channels/${RANDOM_CHANNEL_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("chat-title")).toHaveText("random");

    // Both header controls render, and the activity button sits immediately
    // left of Buzz Term inside the same actions row.
    await expect(activityButton(page)).toBeVisible();
    const terminalButton = page.getByRole("button", {
      name: "Open Buzz Term",
    });
    await expect(terminalButton).toBeVisible();
    const activityBox = await activityButton(page).boundingBox();
    const terminalBox = await terminalButton.boundingBox();
    expect(activityBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    expect(activityBox!.x).toBeLessThan(terminalBox!.x);
    expect(activityBox!.y).toBe(terminalBox!.y);

    // Golden path: click opens the agent session pane scoped to this channel.
    await activityButton(page).click();
    await expect(
      page.getByTestId("agent-session-thread-panel"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("agent-session-agent-name")).toHaveText(
      "Observer Agent",
    );
    await expect(page.getByTestId("agent-session-scope-label")).toContainText(
      "#random",
    );
  });

  test("agent DM: renders and opens that agent's pane", async ({ page }) => {
    await installMockBridge(page);

    // alice-tyler is the seeded 1:1 DM, and alice is one of the default mock
    // relay agents — the exact shape the DM branch targets.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByTestId("channel-alice-tyler").click();
    await expect(page.getByTestId("chat-title")).toHaveText("alice-tyler");

    await expect(activityButton(page)).toBeVisible();
    await activityButton(page).click();
    await expect(
      page.getByTestId("agent-session-thread-panel"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("agent-session-agent-name")).toHaveText(
      "alice",
    );
  });

  test("human DM: button stays hidden", async ({ page }) => {
    await installMockBridge(page);

    // bob is a seeded identity but NOT a default mock relay agent, so a
    // fresh 1:1 DM with bob has no agent participant.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openNewMessagePage(page);
    await page.getByTestId("new-dm-search").fill("bob");
    await page
      .getByTestId(`new-dm-result-${TEST_IDENTITIES.bob.pubkey}`)
      .click();
    await page.getByTestId("message-input").fill("Hello bob");
    await page.getByTestId("send-message").click();
    await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");

    await expect(activityButton(page)).toHaveCount(0);
  });
});
