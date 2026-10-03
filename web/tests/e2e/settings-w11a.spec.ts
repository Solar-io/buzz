import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent } from "nostr-tools/pure";
import { test } from "./helpers/agentBraveTest";
import {
  installMockRelay,
  mockEvent,
  type MockEvent,
} from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";
import { buildWorkFixture, routeUsageHub } from "./helpers/workFixture";

async function settings(page: Page, reject = false) {
  const fixture = buildWorkFixture();
  const newKey = "c1".repeat(32);
  const conversationKey = nip44.v2.utils.getConversationKey(
    fixture.viewerKey,
    fixture.viewer,
  );
  let sequence = 100;
  const event = (overrides: Partial<MockEvent>) =>
    mockEvent({
      pubkey: fixture.viewer,
      id: (sequence++).toString(16).padStart(64, "0"),
      ...overrides,
    });
  const catalog = (agents: string[]) =>
    event({
      kind: 30180,
      created_at: Math.floor(Date.now() / 1000) + sequence,
      tags: [["d", "crichton.local"]],
      content: JSON.stringify({
        format: "buzz-desktop-catalog",
        version: 4,
        machine: "crichton.local",
        updated_at: Math.floor(Date.now() / 1000),
        agents,
        harnesses: [
          {
            id: "buzz-agent",
            label: "Buzz Agent",
            source: "builtin",
            availability: "available",
          },
          {
            id: "codex",
            label: "Codex",
            source: "preset",
            availability: "available",
          },
        ],
      }),
    });
  const events = fixture.events.filter(
    (entry) => ![30177, 30180, 30175, 30176].includes(entry.kind),
  );
  events.push(
    catalog([]),
    event({
      kind: 30175,
      tags: [["d", "w11a-definition"]],
      content: JSON.stringify({
        display_name: "W11a definition",
        system_prompt: "Library instructions.",
        runtime: "codex",
      }),
    }),
    event({
      kind: 30176,
      tags: [["d", "w11a-team"]],
      content: JSON.stringify({
        name: "W11a team",
        persona_ids: ["w11a-definition"],
      }),
    }),
    finalizeEvent(
      {
        kind: 30175,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["d", "w11a-publication"],
          ["shared", "true"],
        ],
        content: JSON.stringify({
          display_name: "W11a shared catalog",
          system_prompt: "Shared instructions.",
          runtime: "codex",
        }),
      },
      fixture.agents.acid.secretKey,
    ),
  );
  await page.addInitScript(() => {
    localStorage.setItem("buzz-theme", "buzz-dark");
    localStorage.setItem("buzz-follow-system", "false");
  });
  await routeUsageHub(page);
  const commands: Record<string, unknown>[] = [];
  let answer: (() => void) | undefined;
  await installMockRelay(page, events, {
    onPublish: (published, relay) => {
      if (published.kind !== 24201) return;
      const command = JSON.parse(
        nip44.v2.decrypt(published.content, conversationKey),
      );
      commands.push(command);
      answer = () => {
        if (!reject)
          relay.push(
            event({
              kind: 30177,
              tags: [["d", newKey]],
              content: JSON.stringify({
                name: command.request.name,
                system_prompt: command.request.systemPrompt,
                model: "opus",
                respond_to: "owner-only",
              }),
            }),
            catalog([newKey]),
          );
        relay.push(
          event({
            kind: 24202,
            content: nip44.v2.encrypt(
              JSON.stringify({
                type: "agent_admin_ack",
                requestId: command.requestId,
                ok: !reject,
                ...(reject
                  ? { error: "Runtime is not installed" }
                  : { agentPubkey: newKey }),
              }),
              conversationKey,
            ),
          }),
        );
      };
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
  await page.goto("/repos/settings?group=agents");
  await expect(
    page.getByRole("button", { name: "New agent", exact: true }),
  ).toHaveCount(1);
  return {
    commands,
    newKey,
    answer: () => {
      expect(answer).toBeDefined();
      answer?.();
    },
  };
}

async function blank(page: Page) {
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  const definition = page.getByRole("menuitem", { name: /From a definition/ });
  await expect(definition).toBeDisabled();
  await expect(definition).toContainText("Update Buzz Desktop");
  await expect(
    page.getByRole("menuitem", { name: /From a team/ }),
  ).toBeDisabled();
  await page
    .getByRole("menuitem", { name: "Blank agent", exact: true })
    .click();
  await expect(page.getByTestId("blank-agent-create")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("W11a throwaway");
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("Reply briefly.");
}

async function screenshot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const dir = path.resolve("../.scratch/w11a/screenshots");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    fullPage: true,
  });
}

for (const width of [1440, 390]) {
  test(`W11a blank creation waits for the desktop and opens the new agent at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    const state = await settings(page);
    await blank(page);
    await page
      .getByLabel("Runtime", { exact: true })
      .selectOption("value:codex");
    await page
      .getByLabel("Idle timeout", { exact: true })
      .selectOption("value:1800");
    await screenshot(page, `blank-${width}`);
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect.poll(() => state.commands.length).toBe(1);
    expect(state.commands[0]).toMatchObject({
      action: "create",
      target: "crichton.local",
      request: {
        name: "W11a throwaway",
        systemPrompt: "Reply briefly.",
        harness: { kind: "preset", runtimeId: "codex" },
        idleTimeoutSeconds: 1800,
        maxTurnDurationSeconds: 43200,
        spawnAfterCreate: true,
        startOnAppLaunch: true,
      },
    });
    await expect(
      page.getByRole("button", { name: "Waiting for desktop…", exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId("agent-screen")).toHaveCount(0);
    state.answer();
    await expect(page).toHaveURL(new RegExp(`agent=${state.newKey}`));
    await expect(page.getByTestId("agent-header")).toContainText(
      "W11a throwaway",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "← Agents", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /W11a throwaway/ }),
    ).toBeVisible();
  });

  test(`W11a library relocates definitions, teams, catalog and snapshot preview at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await settings(page);
    await page.goto("/repos/settings?group=library");
    const panel = page.getByRole("tabpanel");
    await expect(panel).toContainText("W11a definition");
    await expect(page.getByRole("tab")).toHaveCount(4);
    await screenshot(page, `library-${width}`);
    await page.getByRole("tab", { name: "Teams", exact: true }).click();
    await expect(panel).toContainText("W11a team");
    await page.getByRole("tab", { name: "Catalog", exact: true }).click();
    await expect(panel).toContainText("W11a shared catalog");
    await page.getByRole("tab", { name: "Snapshots", exact: true }).click();
    await expect(panel).toContainText("Agent snapshots");
    await page.getByTestId("web-import-snapshot-input").setInputFiles({
      name: "sample.agent.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "buzz-agent-snapshot",
          version: 1,
          definition: {
            name: "W11a imported",
            systemPrompt: "Snapshot instructions.",
            sourceIsBuiltin: false,
            parallelism: 10,
          },
          profile: { displayName: "W11a imported" },
          memory: { level: "none" },
        }),
      ),
    });
    await expect(page.getByRole("dialog")).toContainText("W11a imported");
    await expect(page.getByRole("dialog")).toContainText(
      "Snapshot instructions.",
    );
  });
}

test("W11a retains a refused draft and guards navigation", async ({ page }) => {
  const state = await settings(page, true);
  await blank(page);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect.poll(() => state.commands.length).toBe(1);
  state.answer();
  await expect(page.getByRole("alert")).toContainText(
    "Runtime is not installed",
  );
  await expect(
    page.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("W11a throwaway");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByTestId("settings-nav-item-library")
    .click();
  await expect(page.getByRole("dialog")).toContainText("Discard");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByTestId("blank-agent-create")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Discard changes to the new agent?",
  );
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByTestId("blank-agent-create")).toHaveCount(0);
});
