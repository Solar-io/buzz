import { expect, test as base, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as nip44 from "nostr-tools/nip44";
import {
  installMockRelay,
  mockEvent,
  type MockEvent,
} from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";
import {
  buildWorkFixture,
  routeUsageHub,
  type WorkFixture,
} from "./helpers/workFixture";

// Local runs can use the shared Agent Brave instead of launching another browser.
// CI retains the suite's normal isolated browser. Never close the shared browser.
const test = process.env.BUZZ_E2E_CDP
  ? base.extend({
      browser: async ({ playwright }, use) => {
        await use(
          await playwright.chromium.connectOverCDP(
            process.env.BUZZ_E2E_CDP as string,
          ),
        );
      },
    })
  : base;

function selfSeal(fixture: WorkFixture, value: unknown) {
  return nip44.v2.encrypt(
    JSON.stringify(value),
    nip44.v2.utils.getConversationKey(fixture.viewerKey, fixture.viewer),
  );
}
function adminPayload(fixture: WorkFixture, event: MockEvent) {
  return JSON.parse(
    nip44.v2.decrypt(
      event.content,
      nip44.v2.utils.getConversationKey(fixture.viewerKey, fixture.viewer),
    ),
  );
}

async function settings(page: Page, { rejectAdd = false, stale = false } = {}) {
  const fixture = buildWorkFixture();
  const agent = fixture.agents.acid;
  const channel = fixture.channels.engineering;
  let revision = Math.floor(Date.now() / 1000);
  const members = new Set([channel]);
  const snapshot = (id: string) =>
    mockEvent({
      id: (revision++).toString(16).padStart(64, "0"),
      kind: 39002,
      created_at: revision,
      tags: [
        ["d", id],
        ["p", fixture.viewer, "admin"],
        ...(members.has(id) ? [["p", agent.pubkey, "bot"]] : []),
      ],
    });
  const observer = (kind: string, payload: unknown) =>
    mockEvent({
      id: (revision++).toString(16).padStart(64, "0"),
      kind: 24200,
      pubkey: agent.pubkey,
      created_at: revision,
      tags: [
        ["p", fixture.viewer],
        ["agent", agent.pubkey],
      ],
      content: nip44.v2.encrypt(
        JSON.stringify({
          seq: revision,
          timestamp: new Date().toISOString(),
          kind,
          channelId: channel,
          sessionId: "s-t-acid",
          turnId: "t-acid",
          agentIndex: 0,
          payload,
        }),
        nip44.v2.utils.getConversationKey(agent.secretKey, fixture.viewer),
      ),
    });
  const ownerRecords = [agent, fixture.agents.gilfoyle].map((entry, index) =>
    mockEvent({
      id: `${index + 80}`.repeat(32),
      kind: 30177,
      pubkey: fixture.viewer,
      tags: [["d", entry.pubkey]],
      content: JSON.stringify({
        name: entry.name,
        model: "opus",
        system_prompt: "Test agent.",
        respond_to: "owner-only",
        effort: { acp: "medium" },
      }),
    }),
  );
  const events = fixture.events.filter(
    (event) => ![30177, 30180, 39002].includes(event.kind),
  );
  events.push(
    observer("session_config_captured", {
      models: { currentModelId: "running-opus" },
    }),
  );
  events.push(
    ...ownerRecords,
    ...Object.values(fixture.channels).map(snapshot),
    mockEvent({
      id: "82".repeat(32),
      kind: 30180,
      pubkey: fixture.viewer,
      created_at: Math.floor(Date.now() / 1000) - (stale ? 8 * 3600 : 60),
      tags: [["d", "crichton.local"]],
      content: JSON.stringify({
        format: "buzz-desktop-catalog",
        version: 4,
        machine: "crichton.local",
        agents: [agent.pubkey, fixture.agents.gilfoyle.pubkey],
        harnesses: [],
        updated_at: Math.floor(Date.now() / 1000) - (stale ? 8 * 3600 : 60),
      }),
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("buzz-theme", "buzz-dark");
    localStorage.setItem("buzz-follow-system", "false");
  });
  await routeUsageHub(page);
  const relay = await installMockRelay(page, events, {
    rejectPublish: (event) =>
      rejectAdd && event.kind === 9000 ? "Channel admin required" : null,
    onPublish: (event, handle) => {
      if (event.kind === 24200) {
        const control = JSON.parse(
          nip44.v2.decrypt(
            event.content,
            nip44.v2.utils.getConversationKey(agent.secretKey, fixture.viewer),
          ),
        ).payload;
        if (control.type === "switch_model")
          handle.push(
            observer("session_config_captured", {
              models: { currentModelId: control.modelId },
            }),
          );
        if (control.type === "cancel_turn")
          handle.push(observer("turn_completed", { stopReason: "cancelled" }));
      }
      if (event.kind === 9000 || event.kind === 9001) {
        const id = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (id) {
          if (event.kind === 9000) members.add(id);
          else members.delete(id);
          handle.push(snapshot(id));
        }
      }
      if (event.kind === 24201) {
        const command = adminPayload(fixture, event);
        handle.push(
          mockEvent({
            id: (revision++).toString(16).padStart(64, "0"),
            kind: 24202,
            pubkey: fixture.viewer,
            content: selfSeal(fixture, {
              type: "agent_admin_ack",
              requestId: command.requestId,
              ok: true,
              agentPubkey: command.request.pubkey,
            }),
          }),
        );
      }
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
  await expect(page.getByTestId("agent-header")).toContainText("Acid Burn");
  await expect(page.getByTestId("agent-channels-card")).toContainText(
    "engineering",
  );
  return { fixture, relay, agent, channel };
}

async function screenshot(page: Page, name: string) {
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
  const dir = path.resolve("../.scratch");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    fullPage: false,
  });
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const header = await page.getByTestId("agent-header").boundingBox();
  const tabs = await page.getByTestId("agent-tabs").boundingBox();
  expect(header).not.toBeNull();
  expect(tabs).not.toBeNull();
  expect((header?.y ?? 0) + (header?.height ?? 0)).toBeLessThanOrEqual(
    tabs?.y ?? 0,
  );
}

test("W9a ‹ › steps through roster order and keeps URL selection on Back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const { fixture } = await settings(page);
  await expect(page.getByTestId("agent-roster-position")).toHaveText("1 of 2");
  await expect(
    page.getByRole("button", { name: "Previous agent" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Next agent" }).click();
  await expect(page).toHaveURL(
    new RegExp(`agent=${fixture.agents.gilfoyle.pubkey}`),
  );
  await expect(page.getByTestId("agent-header")).toContainText("Gilfoyle");
  await expect(page.getByRole("button", { name: "Next agent" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous agent" }).click();
  await expect(page.getByTestId("agent-header")).toContainText("Acid Burn");
  await noOverflow(page);
  await screenshot(page, "w9a-agent-1440");
});
test("W9a Channels add publishes 9000 then targeted start, and removes with 9001", async ({
  page,
}) => {
  const { fixture, relay, agent } = await settings(page);
  await page.getByRole("button", { name: "Channels 1", exact: true }).click();
  const tab = page.getByTestId("agent-channels-tab");
  const target = fixture.channels.design;
  await tab.getByLabel("Add to a channel").selectOption(target);
  await tab.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    tab.getByRole("link", { name: "design", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        relay.published.filter((event) => [9000, 24201].includes(event.kind))
          .length,
    )
    .toBe(2);
  const sent = relay.published.filter((event) =>
    [9000, 24201].includes(event.kind),
  );
  expect(sent[0].kind).toBe(9000);
  expect(sent[0].tags).toEqual([
    ["h", target],
    ["p", agent.pubkey],
    ["role", "bot"],
  ]);
  expect(adminPayload(fixture, sent[1])).toMatchObject({
    action: "start",
    target: "crichton.local",
    request: { pubkey: agent.pubkey },
  });
  await expect(page.getByTestId("agent-screen")).toContainText(
    "Saved on crichton",
  );
  await tab
    .getByRole("button", { name: "Remove from design", exact: true })
    .click();
  await expect(
    tab.getByRole("link", { name: "design", exact: true }),
  ).toHaveCount(0);
  expect(relay.published.find((event) => event.kind === 9001)?.tags).toEqual([
    ["h", target],
    ["p", agent.pubkey],
  ]);
});
test("W9a refused channel membership never sends start", async ({ page }) => {
  const { relay } = await settings(page, { rejectAdd: true });
  await page.getByRole("button", { name: "Channels 1", exact: true }).click();
  await page
    .getByTestId("agent-channels-tab")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await expect(
    page.getByText("Channel admin required", { exact: true }),
  ).toBeVisible();
  expect(relay.published.filter((event) => event.kind === 24201)).toHaveLength(
    0,
  );
});
test("W9a live model switch and Cancel turn encrypt the right conversation and agent", async ({
  page,
}) => {
  const { fixture, relay, agent, channel } = await settings(page);
  const now = page.getByTestId("agent-right-now");
  await expect(now.getByTestId("agent-live-model")).toHaveText("running-opus");
  await now.getByLabel("Live model").fill("codex-test-model");
  await now.getByRole("button", { name: "Switch model", exact: true }).click();
  await expect(now.getByTestId("agent-live-model")).toHaveText(
    "codex-test-model",
  );
  await now.getByRole("button", { name: "Cancel turn", exact: true }).click();
  await expect(now).toContainText("No turn in progress");
  await expect
    .poll(() => relay.published.filter((event) => event.kind === 24200))
    .toHaveLength(2);
  const controls = relay.published
    .filter((event) => event.kind === 24200)
    .map((event) => {
      expect(event.tags).toEqual([
        ["p", agent.pubkey],
        ["agent", agent.pubkey],
        ["frame", "control"],
      ]);
      return JSON.parse(
        nip44.v2.decrypt(
          event.content,
          nip44.v2.utils.getConversationKey(agent.secretKey, fixture.viewer),
        ),
      );
    });
  expect(controls[0].payload).toMatchObject({
    type: "switch_model",
    channelId: channel,
    modelId: "codex-test-model",
  });
  expect(controls[1].payload).toMatchObject({
    type: "cancel_turn",
    channelId: channel,
  });
});
test("W9a Logs stays locked, Memory and inline Activity are reachable and reloadable", async ({
  page,
}) => {
  await settings(page);
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.getByTestId("agent-logs-locked")).toContainText(
    "Update Buzz Desktop on crichton to view logs here.",
  );
  await page.reload();
  await expect(page.getByTestId("agent-logs-locked")).toBeVisible();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page).toHaveURL(/tab=memory/);
  await expect(page.getByTestId("agent-screen")).toContainText(
    /No memor|memor/i,
  );
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.locator("[data-thinking-pane]")).toBeVisible();
  expect(
    await page
      .locator("[data-thinking-pane]")
      .evaluate((element) => getComputedStyle(element).position),
  ).not.toBe("fixed");
});
test("W9a stale desktop report locks lifecycle and channel writes", async ({
  page,
}) => {
  await settings(page, { stale: true });
  await expect(
    page
      .getByTestId("agent-action-row")
      .getByRole("button", { name: "Stop", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByTestId("agent-action-row")
      .getByRole("button", { name: "Restart", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByTestId("agent-channels-card")
      .getByRole("button", { name: "Add", exact: true }),
  ).toBeDisabled();
});
for (const width of [390, 375])
  test(`W9a ${width} phone segments, sub-page pushes and no overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await settings(page);
    const tabs = page.getByTestId("agent-tabs");
    await expect(
      tabs.getByRole("button", { name: "Memory", exact: true }),
    ).toBeHidden();
    await expect(
      tabs.getByRole("button", { name: "Activity", exact: true }),
    ).toBeHidden();
    expect(
      await page
        .getByTestId("agent-action-row")
        .getByRole("button", { name: "Restart", exact: true })
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await noOverflow(page);
    await screenshot(page, `w9a-agent-${width}`);
    await page
      .getByRole("button", { name: "Memory", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/tab=memory/);
    await expect(
      page.getByRole("button", { name: "← Agent settings", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "← Agent settings", exact: true })
      .click();
    await tabs.getByRole("button", { name: "Channels 1", exact: true }).click();
    await expect(page.getByTestId("agent-channels-tab")).toBeVisible();
    await noOverflow(page);
  });
