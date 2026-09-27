import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// Owner ask: hovering an agent's AVATAR shows its model + manually set knobs
// (effort…); hovering its NAME must not. Charlie is the seeded `bot` author
// of a #agents message (see profile-active-turn.spec.ts); seeding a managed
// agent on the same pubkey gives the popover a model and an effort block.
const AGENT_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";

function seed() {
  return {
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Charlie",
        status: "running" as const,
        channelNames: ["agents"],
        model: "claude-opus-5-5-e2e",
        effort: { acp: "medium", text_turn: "low" },
      },
    ],
  };
}

function agentRow(page: import("@playwright/test").Page) {
  return page
    .getByTestId("message-row")
    .filter({ has: page.locator('[data-testid^="message-avatar-"]') })
    .last();
}

async function openAgentsChannel(page: import("@playwright/test").Page) {
  await installMockBridge(page, seed());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");
}

test.describe("agent avatar config card", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("hovering the avatar shows the agent config rows", async ({ page }) => {
    await openAgentsChannel(page);
    await agentRow(page).getByRole("button").first().hover();

    const popover = page.getByTestId("user-profile-popover");
    await expect(popover).toBeVisible({ timeout: 5_000 });
    const section = popover.getByTestId("agent-config-section");
    await expect(section).toBeVisible();
    await expect(section).toContainText("claude-opus-5-5-e2e");
    await expect(section).toContainText("medium");
    await expect(section).toContainText("Text-turn effort");
  });

  test("hovering the name shows the profile without agent config", async ({
    page,
  }) => {
    await openAgentsChannel(page);
    // The author-name button (the TriggerElement wrapper also has role=button).
    const name = agentRow(page).locator("button.leading-message-author");
    await expect(name).toHaveText("Charlie");
    await name.hover();

    const popover = page.getByTestId("user-profile-popover");
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await expect(popover.getByTestId("agent-config-section")).toHaveCount(0);
    await expect(popover).not.toContainText("claude-opus-5-5-e2e");
  });
});
