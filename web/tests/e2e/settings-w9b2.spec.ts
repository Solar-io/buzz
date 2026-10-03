import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/agentBraveTest";
import { setup, screenshot } from "./helpers/agentSettingsFixture";

async function save(page: Page) {
  const bar = page.getByRole("region", { name: "Settings changes" });
  await bar.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(bar).toContainText("Saved on crichton.local");
}
async function subpage(page: Page, label: string) {
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page.getByRole("button", { name: label, exact: true }).click();
}
async function env(page: Page) {
  await subpage(page, "Environment variables");
  const card = page.getByTestId("env-vars-card");
  await expect(card.locator("details")).not.toHaveAttribute("open");
  await card.locator("summary").click();
  await card.getByRole("button", { name: "Add variable", exact: true }).click();
  return card;
}

test("W9b2 FOO patch set and delete are acked; secrets stay out of drafts and storage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page);
  const card = await env(page);
  await card.getByLabel("Variable 1 name").fill("FOO");
  await card.getByLabel("Variable 1 value").fill("bar-synthetic-secret");
  const bar = page.getByRole("region", { name: "Settings changes" });
  await expect(bar).not.toContainText("bar-synthetic-secret");
  await save(page);
  expect(state.commands[0]).toMatchObject({
    action: "update",
    target: "crichton.local",
    request: {
      pubkey: state.agent.pubkey,
      envVarsPatch: { FOO: "bar-synthetic-secret" },
    },
  });
  expect(
    (state.commands[0].request as Record<string, unknown>).envVars,
  ).toBeUndefined();
  await expect(card.getByLabel("Variable 1 value")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await card.getByRole("button", { name: "Add variable", exact: true }).click();
  await card.getByLabel("Variable 1 name").fill("FOO");
  await card.getByLabel("Variable 1 action").selectOption("remove");
  await save(page);
  expect(state.commands[1]).toMatchObject({
    request: { envVarsPatch: { FOO: null } },
  });
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    ),
  ).not.toContain("bar-synthetic-secret");
  await screenshot(page, "w9b2-desktop-1440");
});
test("W9b2 phone identity, environment and remove subpages fit at 390", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const state = await setup(page);
  await subpage(page, "Identity");
  await page.getByLabel("Agent name", { exact: true }).fill("W9b2 test name");
  await page
    .getByLabel("System prompt", { exact: true })
    .fill("W9b2 test instructions");
  await screenshot(page, "w9b2-identity-390");
  await save(page);
  expect(state.commands[0]).toMatchObject({
    request: { name: "W9b2 test name", systemPrompt: "W9b2 test instructions" },
  });
  await page
    .getByRole("button", { name: "← Agent settings", exact: true })
    .click();
  const card = await env(page);
  await card.getByLabel("Variable 1 name").fill("FOO");
  await card.getByLabel("Variable 1 value").fill("bar");
  await screenshot(page, "w9b2-environment-390");
  await save(page);
  await page
    .getByRole("button", { name: "← Agent settings", exact: true })
    .click();
  await subpage(page, "Remove agent");
  await page
    .getByTestId("remove-card")
    .getByRole("button", { name: "Delete…", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("1 channel");
  expect(state.commands).toHaveLength(2);
  await screenshot(page, "w9b2-remove-confirm-390");
});
test("W9b2 linked identity opens its Library definition; old route redirects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await setup(page, { linked: true });
  await expect(page.getByTestId("identity-card")).toContainText(
    "Shared definition",
  );
  await expect(
    page.getByTestId("identity-card").getByLabel("System prompt"),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Edit definition", exact: true })
    .click();
  await expect(page).toHaveURL(
    /group=library&tab=definitions&definition=b07a1d11/,
  );
  await expect(
    page.getByRole("button", { name: "All definitions", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("System prompt", { exact: true })).toBeVisible();
  await page.goto("/repos/agents");
  await expect(page).toHaveURL(/\/repos\/settings\?group=agents/);
});
test("W9b2 Delete confirmation waits for ack and refusal keeps the agent screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page, { delayed: true, reject: true });
  await page
    .getByTestId("remove-card")
    .getByRole("button", { name: "Delete…", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 channel");
  expect(state.commands).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect.poll(() => state.commands.length).toBe(1);
  await expect(dialog).toContainText("Waiting for Buzz Desktop");
  await expect(page.getByTestId("agent-screen")).toBeVisible();
  expect(state.commands[0]).toMatchObject({
    action: "delete",
    request: { pubkey: state.agent.pubkey, forceRemoteDelete: true },
  });
  state.release();
  await expect(dialog).toContainText("The desktop refused this edit.");
  await expect(page.getByTestId("agent-screen")).toBeVisible();
});
test("W9b2 reserved key blocks save; desktop refusal preserves the blind patch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page, { reject: true });
  const card = await env(page);
  await card.getByLabel("Variable 1 name").fill("BUZZ_PRIVATE_KEY");
  await card.getByLabel("Variable 1 value").fill("synthetic");
  await expect(card.getByRole("alert")).toContainText("is set by Buzz");
  const bar = page.getByRole("region", { name: "Settings changes" });
  await bar.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(bar).toContainText("is set by Buzz");
  expect(state.commands).toHaveLength(0);
  await card.getByLabel("Variable 1 name").fill("FOO");
  await bar.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(bar).toContainText("The desktop refused this edit.");
  await expect(card.getByLabel("Variable 1 value")).toHaveValue("synthetic");
  expect(state.commands).toHaveLength(1);
});
