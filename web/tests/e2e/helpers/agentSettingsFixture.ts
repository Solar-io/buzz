import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as nip44 from "nostr-tools/nip44";
import { installMockRelay, mockEvent, type MockEvent } from "./mockRelay";
import { buildWorkFixture, routeUsageHub } from "./workFixture";
import { signIn } from "./signIn";

export async function setup(
  page: Page,
  options: {
    reject?: boolean;
    delayed?: boolean;
    stale?: boolean;
    linked?: boolean;
  } = {},
) {
  // Shared CDP clients may both dismiss a teardown beforeunload dialog.
  // Handle our own page's dialogs and tolerate only an already-handled dialog.
  page.on(
    "dialog",
    (dialog) =>
      void dialog.dismiss().catch((error) => {
        if (!String(error).includes("No dialog is showing")) throw error;
      }),
  );
  const fixture = buildWorkFixture();
  const agent = fixture.agents.acid;
  let revision = Math.floor(Date.now() / 1000);
  const publicSettings = {
    name: agent.name,
    system_prompt: "Original instructions",
    ...(options.linked
      ? { persona_id: "b07a1d11-1234-4321-8123-abcdef123456" }
      : {}),
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
  if (options.linked)
    events.push(
      mockEvent({
        kind: 30175,
        pubkey: fixture.viewer,
        tags: [["d", "b07a1d11-1234-4321-8123-abcdef123456"]],
        content: JSON.stringify({
          display_name: "Shared definition",
          system_prompt: "Shared instructions",
          model: "opus",
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
          if (request.name) publicSettings.name = request.name;
          if (request.systemPrompt)
            publicSettings.system_prompt = request.systemPrompt;
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
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page
      .getByTestId("phone-more-sheet")
      .getByText("Settings", { exact: true })
      .click();
  } else {
    await page.getByTestId("sidebar-app-menu").click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
  }
  // Manual entry intentionally locks on reload. Remember this disposable key
  // through the actual setting before exercising deep links and reloads.
  await page
    .getByTestId("settings-nav-item-security")
    .filter({ visible: true })
    .click();
  const staySignedIn = page
    .getByText("Stay signed in", { exact: true })
    .locator("..");
  if ((await staySignedIn.getByRole("button").textContent()) === "Off")
    await staySignedIn.getByRole("button").click();
  await expect(staySignedIn.getByRole("button")).toHaveText("On");
  await page.goto(`/repos/settings?group=agents&agent=${agent.pubkey}`);
  await expect(page.getByTestId("model-thinking-card")).toBeVisible();
  return { fixture, agent, commands, relay, release: () => release() };
}
export async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  const dir = path.resolve("../.scratch/w9b2");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  let controls = await page
    .getByTestId("agent-settings-cards")
    .locator(
      "select:visible, input:visible:not([type=checkbox]):not([type=radio])",
    )
    .evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
        };
      }),
    );
  if (controls.length === 0) {
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    controls = await dialog.locator("button:visible").evaluateAll((elements) =>
      elements
        .filter((el) => el.textContent?.trim() !== "Close")
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            width: r.width,
            height: r.height,
          };
        }),
    );
  }
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 1440,
    );
    if ((page.viewportSize()?.width ?? 1440) < 768)
      expect(control.height).toBeGreaterThanOrEqual(44);
  }
}
