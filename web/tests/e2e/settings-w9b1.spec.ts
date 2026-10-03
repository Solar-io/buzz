import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/agentBraveTest";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as nip44 from "nostr-tools/nip44";
import {
  installMockRelay,
  mockEvent,
  type MockEvent,
} from "./helpers/mockRelay";
import { buildWorkFixture, routeUsageHub } from "./helpers/workFixture";
import { signIn } from "./helpers/signIn";

async function setup(
  page: Page,
  options: { reject?: boolean; delayed?: boolean; stale?: boolean } = {},
) {
  const fixture = buildWorkFixture();
  const agent = fixture.agents.acid;
  let revision = Math.floor(Date.now() / 1000);
  const publicSettings = {
    name: agent.name,
    model: "opus",
    provider: "openrouter",
    parallelism: 2,
    respond_to: "owner-only",
    respond_to_allowlist: [] as string[],
    effort: { acp: "medium" },
  };
  const registry = () =>
    mockEvent({
      kind: 30177,
      id: (revision++).toString(16).padStart(64, "0"),
      pubkey: fixture.viewer,
      created_at: revision,
      tags: [["d", agent.pubkey]],
      content: JSON.stringify(publicSettings),
    });
  const seal = (payload: unknown) =>
    nip44.v2.encrypt(
      JSON.stringify(payload),
      nip44.v2.utils.getConversationKey(fixture.viewerKey, fixture.viewer),
    );
  const decode = (event: MockEvent) =>
    JSON.parse(
      nip44.v2.decrypt(
        event.content,
        nip44.v2.utils.getConversationKey(fixture.viewerKey, fixture.viewer),
      ),
    );
  const events = fixture.events.filter(
    (event) => ![30177, 30180].includes(event.kind),
  );
  events.push(
    registry(),
    mockEvent({
      kind: 39002,
      id: "43".repeat(32),
      tags: [
        ["d", fixture.channels.engineering],
        ["p", fixture.viewer, "admin"],
        ["p", agent.pubkey, "bot"],
      ],
    }),
    mockEvent({
      kind: 0,
      id: "44".repeat(32),
      pubkey: fixture.viewer,
      content: JSON.stringify({ name: "Sam", display_name: "Sam" }),
    }),
    mockEvent({
      kind: 30180,
      id: "45".repeat(32),
      pubkey: fixture.viewer,
      created_at: revision - (options.stale ? 8 * 3600 : 60),
      tags: [["d", "crichton.local"]],
      content: JSON.stringify({
        format: "buzz-desktop-catalog",
        version: 4,
        machine: "crichton.local",
        agents: [agent.pubkey],
        harnesses: ["claude", "buzz-agent", "goose"].map((id) => ({
          id,
          label:
            id === "claude"
              ? "Claude Code"
              : id === "goose"
                ? "Goose"
                : "Buzz Agent",
          source: "builtin",
          availability: "available",
        })),
        updated_at: revision - (options.stale ? 8 * 3600 : 60),
      }),
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("buzz-theme", "buzz-dark");
    localStorage.setItem("buzz-follow-system", "false");
  });
  await routeUsageHub(page);
  const commands: Record<string, unknown>[] = [];
  let release = () => {};
  const relay = await installMockRelay(page, events, {
    onPublish: (event, handle) => {
      if (event.kind !== 24201) return;
      const payload = decode(event);
      commands.push(payload);
      const request = payload.request;
      const ack = () => {
        if (!options.reject) {
          if (request.respondTo) publicSettings.respond_to = request.respondTo;
          if (request.respondToAllowlist)
            publicSettings.respond_to_allowlist = request.respondToAllowlist;
          if (request.model) publicSettings.model = request.model;
          if (request.provider) publicSettings.provider = request.provider;
          if (request.parallelism)
            publicSettings.parallelism = request.parallelism;
          handle.push(registry());
        }
        handle.push(
          mockEvent({
            kind: 24202,
            id: (revision++).toString(16).padStart(64, "0"),
            pubkey: fixture.viewer,
            content: seal({
              type: "agent_admin_ack",
              requestId: payload.requestId,
              ok: !options.reject,
              error: options.reject
                ? "The desktop refused this edit."
                : undefined,
              agentPubkey: agent.pubkey,
            }),
          }),
        );
      };
      if (options.delayed) release = ack;
      else ack();
    },
  });
  await signIn(page, "/repos", fixture.viewerKey);
  await expect(
    page.getByTestId(
      (page.viewportSize()?.width ?? 1440) < 768
        ? "phone-tab-bar"
        : "channel-sidebar",
    ),
  ).toBeVisible();
  await page.goto(`/repos/settings?group=agents&agent=${agent.pubkey}`);
  await expect(page.getByTestId("model-thinking-card")).toBeVisible();
  return { fixture, agent, commands, relay, release: () => release() };
}
async function runtime(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page.getByRole("button", { name: "Runtime", exact: true }).click();
  const card = page.getByTestId("runtime-card");
  const details = card.locator("details");
  if (await details.count()) await details.locator("summary").click();
  return card;
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  const dir = path.resolve("../.scratch/w9b1");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const controls = await page
    .getByTestId("agent-settings-cards")
    .locator("select:visible, input:visible")
    .evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      }),
    );
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 1440,
    );
  }
}

test("W9b1 idle 30 min and Anyone survive acknowledged save and reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page);
  const card = await runtime(page);
  await card
    .getByLabel("Idle timeout", { exact: true })
    .selectOption("value:1800");
  await page
    .getByLabel("Who can instruct", { exact: true })
    .selectOption("anyone");
  await page
    .getByRole("region", { name: "Settings changes" })
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Settings changes" }),
  ).toContainText("Saved on crichton.local");
  expect(state.commands).toHaveLength(1);
  expect(state.commands[0]).toMatchObject({
    target: "crichton.local",
    action: "update",
    request: {
      pubkey: state.agent.pubkey,
      idleTimeoutSeconds: 1800,
      respondTo: "anyone",
    },
  });
  await page.reload();
  await expect(
    page.getByLabel("Who can instruct", { exact: true }),
  ).toHaveValue("anyone");
  await expect(page.getByLabel("Idle timeout", { exact: true })).toHaveValue(
    "value:1800",
  );
  await expect(page.getByTestId("agent-access-warning")).toHaveText(
    "Anyone can use this agent to access your computer, including files, accounts, and connected tools.",
  );
  await screenshot(page, "desktop-1440");
});
test("W9b1 390 and 375 phone sub-pages retain draft and save bar above tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await setup(page);
  await screenshot(page, "phone-390");
  const card = await runtime(page);
  await card
    .getByLabel("Idle timeout", { exact: true })
    .selectOption("value:__custom_duration");
  await card.getByLabel("Idle timeout custom amount").fill("7");
  await card.getByRole("button", { name: "Use", exact: true }).click();
  await screenshot(page, "phone-runtime-390");
  const bar = await page
    .getByRole("region", { name: "Settings changes" })
    .boundingBox();
  const tabs = (await page.getByTestId("phone-tab-bar").count())
    ? await page.getByTestId("phone-tab-bar").boundingBox()
    : null;
  expect(bar).not.toBeNull();
  expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeLessThanOrEqual(
    tabs?.y ?? 1000,
  );
  await page
    .getByRole("button", { name: "← Agent settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Who can instruct", exact: true })
    .click();
  await page
    .getByLabel("Who can instruct", { exact: true })
    .selectOption("allowlist");
  await page
    .getByTestId("instruction-people-picker")
    .getByText("Sam", { exact: true })
    .click();
  await page.setViewportSize({ width: 375, height: 1000 });
  await screenshot(page, "phone-access-375");
  await page
    .getByRole("region", { name: "Settings changes" })
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Settings changes" }),
  ).toContainText("Saved on crichton.local");
});
test("W9b1 relay OK waits for desktop ack; refusal retains edits and no timeout echo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page, { delayed: true, reject: true });
  await (await runtime(page))
    .getByLabel("Idle timeout", { exact: true })
    .selectOption("value:1800");
  await page
    .getByRole("region", { name: "Settings changes" })
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Settings changes" }),
  ).toContainText("Sending to crichton.local");
  await expect.poll(() => state.commands.length).toBe(1);
  await page.waitForTimeout(150);
  await expect(
    page.getByRole("region", { name: "Settings changes" }),
  ).not.toContainText("Saved on");
  state.release();
  await expect(
    page.getByRole("region", { name: "Settings changes" }),
  ).toContainText("The desktop refused this edit.");
  await expect(
    page
      .getByRole("region", { name: "Settings changes" })
      .getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("buzz-settings-timeouts:"),
        ).length,
    ),
  ).toBe(0);
});
test("W9b1 API key is sealed patch-only, absent from receipts and browser storage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page);
  await (await runtime(page))
    .getByLabel("Runtime", { exact: true })
    .selectOption(
      `value:${JSON.stringify({ kind: "preset", runtimeId: "buzz-agent" })}`,
    );
  await page.getByTestId("model-thinking-card").locator("summary").click();
  const key = page.getByTestId("web-provider-api-key");
  await key.getByText("Set new key", { exact: true }).click();
  await key
    .getByLabel("OpenRouter API Key", { exact: true })
    .fill("w9b1-synthetic-key");
  const bar = page.getByRole("region", { name: "Settings changes" });
  await expect(bar).not.toContainText("w9b1-synthetic-key");
  await bar.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(bar).toContainText("Saved on");
  expect(state.commands[0]).toMatchObject({
    request: { envVarsPatch: { OPENROUTER_API_KEY: "w9b1-synthetic-key" } },
  });
  expect(
    (state.commands[0].request as Record<string, unknown>).envVars,
  ).toBeUndefined();
  await expect(bar.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    ),
  ).not.toContain("w9b1-synthetic-key");
});
test("W9b1 dirty agent navigation asks Keep editing or Discard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await setup(page);
  await (await runtime(page))
    .getByLabel("Idle timeout", { exact: true })
    .selectOption("value:1800");
  await page.getByRole("button", { name: "← Agents", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Discard 1 change to Acid Burn?");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByTestId("agent-settings-cards")).toBeVisible();
  await page.getByRole("button", { name: "← Agents", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByTestId("agent-screen")).toHaveCount(0);
});
test("W9b1 stale desktop locks cards and no writes are queued", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page, { stale: true });
  const card = await runtime(page);
  await expect(card.getByLabel("Idle timeout", { exact: true })).toBeDisabled();
  await expect(
    page.getByLabel("Who can instruct", { exact: true }),
  ).toBeDisabled();
  expect(state.commands).toHaveLength(0);
});
