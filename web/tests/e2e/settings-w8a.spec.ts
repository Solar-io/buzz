import { expect } from "@playwright/test";
import { test } from "./helpers/agentBraveTest";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { openRoster } from "./helpers/rosterFixture";

const screenshots = path.resolve(process.cwd(), "../.scratch/w8a/screenshots");
test.use({ viewport: { width: 1440, height: 960 } });

test("W8a desktop roster is reachable, filtered, read-only and opens the agent URL", async ({
  page,
}) => {
  await openRoster(page);
  const roster = page.getByTestId("agent-roster");
  await expect(page.getByTestId("roster-table")).toBeVisible();
  await expect(
    roster.getByRole("button", { name: "All 3", exact: true }),
  ).toBeVisible();
  await expect(
    roster.getByRole("button", { name: "Working 1", exact: true }),
  ).toBeVisible();
  await expect(
    roster.getByRole("button", { name: "Claimed 1", exact: true }),
  ).toBeVisible();
  await expect(
    roster.getByRole("button", { name: "Not on any desktop 1", exact: true }),
  ).toBeVisible();
  await expect(
    roster.getByRole("button", { name: /Crashed|Needs restart/ }),
  ).toHaveCount(0);
  await expect(
    roster.getByRole("columnheader", { name: "Runtime", exact: true }),
  ).toBeVisible();
  await expect(
    roster.getByRole("columnheader", { name: "Acct", exact: true }),
  ).toBeVisible();
  await expect(roster).toContainText("claude-code");
  await page.setViewportSize({ width: 1000, height: 960 });
  await expect(
    roster.getByRole("columnheader", { name: "Runtime", exact: true }),
  ).toHaveCount(0);
  await expect(
    roster.getByRole("columnheader", { name: "Acct", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  const acid = page.getByTestId("roster-row").filter({ hasText: "Acid Burn" });
  await expect(acid).toContainText("Platform Team");
  await expect(acid).toContainText("opus");
  await expect(acid.getByRole("combobox")).toHaveCount(0);
  await roster
    .getByRole("combobox", { name: "Filter by team" })
    .selectOption("Platform Team");
  await expect(page.getByTestId("roster-row")).toHaveCount(1);
  await roster
    .getByRole("combobox", { name: "Filter by team" })
    .selectOption("");
  await roster.getByRole("textbox", { name: "Filter agents" }).fill("SOL");
  await expect(page.getByTestId("roster-row")).toHaveCount(1);
  await expect(page.getByTestId("roster-row")).toContainText("Gilfoyle");
  await roster.getByRole("textbox", { name: "Filter agents" }).fill("");
  mkdirSync(screenshots, { recursive: true });
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: path.join(screenshots, "roster-1440.png") });
  await acid
    .getByRole("button", { name: "Open Acid Burn", exact: true })
    .click();
  await expect(page).toHaveURL(/group=agents&agent=/);
  await expect(page.getByTestId("agent-header")).toContainText("Acid Burn");
});

test("W8a bulk Restart targets each machine, waits for both acks and cycles Working", async ({
  page,
}) => {
  const { agents, commands, ack, working } = await openRoster(page, {
    autoAck: false,
  });
  await page
    .getByRole("checkbox", { name: "Select Acid Burn", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select Gilfoyle", exact: true })
    .check();
  const bulk = page.getByTestId("roster-bulk-bar");
  await bulk.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(
    commands.map(({ action, target, request }) => [
      action,
      target,
      request.pubkey,
    ]),
  ).toEqual([
    ["restart", "crichton.local", agents[0].pubkey],
    ["restart", "second.local", agents[1].pubkey],
  ]);
  await expect(page.getByRole("list", { name: "Action results" })).toHaveCount(
    0,
  );
  ack(commands[0]);
  await expect(
    bulk.getByRole("button", { name: "Restart", exact: true }),
  ).toBeDisabled();
  working(agents[0].pubkey, false);
  await expect(
    page.getByTestId("roster-row").filter({ hasText: "Acid Burn" }),
  ).toContainText("Claimed");
  ack(commands[1]);
  await expect(
    page.getByRole("list", { name: "Action results" }),
  ).toContainText("Acid Burn: Applied on Buzz Desktop");
  await expect(
    page.getByRole("list", { name: "Action results" }),
  ).toContainText("Gilfoyle: Applied on Buzz Desktop");
  working(agents[0].pubkey, true);
  working(agents[1].pubkey, true);
  await expect(
    page.getByTestId("roster-row").filter({ hasText: "Acid Burn" }),
  ).toContainText("Working");
  await expect(
    page.getByTestId("roster-row").filter({ hasText: "Gilfoyle" }),
  ).toContainText("Working");
  await bulk.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Working 2", exact: true }),
  ).toBeVisible();
});

test("W8a stale bulk Unregister removes only its row and rejects late replay", async ({
  page,
}) => {
  const { commands, relay, heads } = await openRoster(page);
  await page
    .getByRole("button", { name: "Not on any desktop 1", exact: true })
    .click();
  await expect(page.getByTestId("roster-row")).toHaveCount(1);
  await page
    .getByRole("checkbox", { name: "Select Cereal Killer", exact: true })
    .check();
  const bulk = page.getByTestId("roster-bulk-bar");
  await expect(
    bulk.getByRole("button", { name: "Restart", exact: true }),
  ).toBeDisabled();
  await bulk.getByRole("button", { name: "Unregister", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Their keys are kept");
  await page
    .getByRole("button", { name: "Unregister agents", exact: true })
    .click();
  await expect(page.getByTestId("roster-row")).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(commands[0].action).toBe("unregister");
  relay.push(heads[2]);
  await page.getByRole("button", { name: "All 2", exact: true }).click();
  await expect(page.getByTestId("roster-row")).toHaveCount(2);
});

test("W8a row Stop reports a desktop refusal and export uses the existing snapshot flow", async ({
  page,
}) => {
  const { commands, ack } = await openRoster(page, { autoAck: false });
  await page
    .getByRole("button", { name: "Actions for Acid Burn", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0].action).toBe("stop");
  ack(commands[0], false, "<b>Exact desktop refusal</b>");
  const receipt = page.getByRole("list", { name: "Action results" });
  await expect(receipt).toContainText("<b>Exact desktop refusal</b>");
  await expect(receipt.locator("b")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Actions for Acid Burn", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Export snapshot", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Acid Burn");
  await expect(page.getByRole("dialog")).toContainText("Memory");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  mkdirSync(screenshots, { recursive: true });
  const artifact = path.join(screenshots, "acid-snapshot.json");
  await (await download).saveAs(artifact);
  const snapshot = JSON.parse(readFileSync(artifact, "utf8"));
  expect(snapshot.format).toBe("buzz-agent-snapshot");
  expect(snapshot.version).toBe(1);
});

test("W8a bulk channel add sends each selected key and surfaces relay refusals", async ({
  page,
}) => {
  const { agents, relay, fixture } = await openRoster(page, {
    rejectAdd: true,
  });
  await page
    .getByRole("checkbox", { name: "Select Acid Burn", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select Gilfoyle", exact: true })
    .check();
  await page
    .getByTestId("roster-bulk-bar")
    .getByRole("button", { name: "Add to channel…", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Add selected agents to channel" })
    .selectOption(fixture.channels.engineering);
  await page.getByRole("button", { name: "Add agents", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Channel admin required",
  );
  const additions = relay.published.filter((entry) => entry.kind === 9000);
  expect(additions).toHaveLength(2);
  expect(
    additions.map((entry) => entry.tags.find((tag) => tag[0] === "p")?.[1]),
  ).toEqual(agents.slice(0, 2).map((agent) => agent.pubkey));
  expect(
    additions.every((entry) =>
      entry.tags.some(
        (tag) => tag[0] === "h" && tag[1] === fixture.channels.engineering,
      ),
    ),
  ).toBe(true);
});

test("W8a stale desktop reports lock lifecycle controls", async ({ page }) => {
  const { commands } = await openRoster(page, { old: true });
  await page
    .getByRole("checkbox", { name: "Select Acid Burn", exact: true })
    .check();
  for (const action of ["Start", "Stop", "Restart"]) {
    await expect(
      page
        .getByTestId("roster-bulk-bar")
        .getByRole("button", { name: action, exact: true }),
    ).toBeDisabled();
  }
  await page
    .getByRole("button", { name: "Actions for Acid Burn", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Restart", exact: true }),
  ).toBeDisabled();
  expect(commands).toHaveLength(0);
});

test("W8a successful channel add, row Start and Message use the served workflow", async ({
  page,
}) => {
  const { commands, relay, fixture, agents } = await openRoster(page);
  await page
    .getByRole("checkbox", { name: "Select Acid Burn", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select Gilfoyle", exact: true })
    .check();
  const bulk = page.getByTestId("roster-bulk-bar");
  await bulk
    .getByRole("button", { name: "Add to channel…", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Add selected agents to channel" })
    .selectOption(fixture.channels.engineering);
  await page.getByRole("button", { name: "Add agents", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("2 added");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await bulk.getByRole("button", { name: "Clear", exact: true }).click();
  await page
    .getByRole("button", { name: "Actions for Gilfoyle", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Action results" }),
  ).toContainText("Gilfoyle: Applied on Buzz Desktop");
  expect(commands).toHaveLength(1);
  expect([
    commands[0].action,
    commands[0].target,
    commands[0].request.pubkey,
  ]).toEqual(["start", "second.local", agents[1].pubkey]);
  await page
    .getByRole("button", { name: "Actions for Gilfoyle", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Message", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`c=${fixture.channels["dm-gilfoyle"]}`),
  );
  const messages = relay.published.filter((entry) => entry.kind === 41010);
  expect(messages).toHaveLength(1);
  expect(messages[0].tags).toEqual([["p", agents[1].pubkey]]);
  await expect(page.getByTestId("composer-input").last()).toBeVisible();
});

test("W8a phone roster has a list, reachable selection and no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRoster(page);
  await expect(page.getByTestId("roster-phone-list")).toBeVisible();
  await expect(page.getByTestId("roster-table")).toHaveCount(0);
  expect(
    await page
      .getByRole("textbox", { name: "Filter agents" })
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThan(250);
  await page
    .getByRole("checkbox", { name: "Select Acid Burn", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select Gilfoyle", exact: true })
    .check();
  await expect(page.getByTestId("roster-bulk-bar")).toContainText("2 selected");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .getByTestId("agent-roster")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  mkdirSync(screenshots, { recursive: true });
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({
    path: path.join(screenshots, "roster-390.png"),
    fullPage: true,
  });
});
