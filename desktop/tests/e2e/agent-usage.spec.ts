import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
const A = "a".repeat(64);
const B = "b".repeat(64);
const at = Math.floor(
  new Date(new Date().setHours(12, 0, 0, 0)).getTime() / 1000,
);
const seed = {
  reports: [
    {
      agent: A,
      at,
      input: "9000000",
      output: "1000000",
      cost: 15.5,
      provider: "Anthropic",
      account: "Claude Max · personal",
      model: "Claude Sonnet",
      tier: "Standard",
    },
    {
      agent: B,
      at,
      input: "18000000",
      output: "2000000",
      cost: 22.5,
      provider: "OpenAI",
      account: "ChatGPT Pro",
      model: "GPT",
      tier: "Fast",
    },
  ],
};
test("one many all none filter every analytics dimension and survive reload", async ({
  page,
}) => {
  await installMockBridge(page, { usageAnalytics: seed });
  await page.goto("/agents/usage");
  await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No agents selected.")).toBeVisible();
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("checkbox").first().check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await expect(page.getByTestId("usage-cost")).toHaveText("$15.50");
  await expect(
    page
      .getByRole("region", { name: "Provider breakdown", exact: true })
      .getByText("OpenAI", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
});
test("custom validation range URL sort search and export", async ({ page }) => {
  await installMockBridge(page, { usageAnalytics: seed });
  await page.goto("/agents/usage");
  await page.getByRole("button", { name: "7D", exact: true }).click();
  await expect(page).toHaveURL(/range=7D/);
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("Start date").fill("2026-09-20");
  await page.getByLabel("End date").fill("2026-09-19");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("start on or before");
  await page.getByRole("button", { name: "30D", exact: true }).click();
  const table = page.getByRole("region", {
    name: "Provider breakdown",
    exact: true,
  });
  await expect(table.locator("tbody th").first()).toHaveText("OpenAI");
  await table.getByRole("button", { name: "Total", exact: true }).click();
  await expect(table.locator("tbody th").first()).toHaveText("Anthropic");
  await table.getByRole("textbox").fill("OpenAI");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("buzz-usage.csv");
});
test("empty disabled unknown and retry states remain truthful", async ({
  page,
}) => {
  await installMockBridge(page, {
    usageAnalytics: {
      ...seed,
      collectionEnabled: false,
      reports: [{ agent: A, at, input: null, output: null, cost: null }],
    },
  });
  await page.goto("/agents/usage");
  await expect(page.getByText("Usage collection is disabled.")).toBeVisible();
  await expect(page.getByTestId("usage-total")).toHaveText("—");
  await expect(page.getByTestId("usage-cost")).toHaveText("—");
});
for (const width of [375, 768, 1024, 1440, 2560]) {
  test(`responsive reference screenshot ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1032 });
    await installMockBridge(page, { usageAnalytics: seed });
    await page.goto("/agents/usage");
    await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
    await waitForAnimations(page);
    expect(
      await page
        .getByTestId("agent-usage-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/agent-usage/usage-${width}.png`,
      fullPage: true,
    });
  });
}
