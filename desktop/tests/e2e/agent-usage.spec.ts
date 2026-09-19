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
      total: "10000000",
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
      total: "20000000",
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
  await page.goto("/#/agents/usage");
  await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No agents selected.")).toBeVisible();
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("checkbox").first().check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await expect(page.getByTestId("usage-cost")).toHaveText(
    "Wire $15.50 · Manifest —",
  );
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
  await page.goto("/#/agents/usage");
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
  await page.goto("/#/agents/usage");
  await expect(page.getByText("Usage collection is disabled.")).toBeVisible();
  await expect(page.getByTestId("usage-total")).toHaveText("—");
  await expect(page.getByTestId("usage-cost")).toHaveText(
    "Wire — · Manifest —",
  );
});
for (const width of [375, 768, 1024, 1440, 2560]) {
  test(`responsive reference screenshot ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1032 });
    await installMockBridge(page, { usageAnalytics: seed });
    await page.goto("/#/agents/usage");
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

for (const theme of ["light", "dark"]) {
  test(`theme ${theme}, maximum text zoom and reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1032 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(
      (value) => {
        localStorage.setItem("buzz-theme", value);
        localStorage.setItem("buzz:text-scale", "1.5");
      },
      theme === "light" ? "buzz" : "buzz-dark",
    );
    await installMockBridge(page, { usageAnalytics: seed });
    await page.goto("/#/agents/usage");
    await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).fontSize,
        ),
      )
      .toBe("24px");
    await waitForAnimations(page);
    expect(
      await page
        .getByTestId("agent-usage-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/agent-usage/usage-${theme}-zoom.png`,
      fullPage: true,
    });
    const firstBar = page.locator(".usage-bar").first();
    await firstBar.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".usage-bar").nth(1)).toBeFocused();
  });
}

test("loading and error states expose retry without invented metrics", async ({
  page,
}) => {
  await installMockBridge(page, {
    usageAnalytics: { error: "Archive temporarily unavailable", delayMs: 300 },
  });
  await page.goto("/#/agents/usage");
  await expect(page.getByText("Loading your usage reports…")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Archive temporarily unavailable",
  );
  await expect(page.getByTestId("usage-total")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Usage could not be loaded.",
  );
});

test("back and forward restore date and agent selection", async ({ page }) => {
  await installMockBridge(page, { usageAnalytics: seed });
  await page.goto(`/#/agents/usage?agents=${A}&range=7D`);
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await page.getByRole("button", { name: "90D", exact: true }).click();
  await expect(page).toHaveURL(/range=90D/);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "7D", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await page.goForward();
  await expect(
    page.getByRole("button", { name: "90D", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
