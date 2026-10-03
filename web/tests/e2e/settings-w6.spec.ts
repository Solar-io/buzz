import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/agentBraveTest";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installMockRelay, mockEvent } from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";
import {
  buildWorkFixture,
  routeUsageHub,
  type WorkFixture,
} from "./helpers/workFixture";

function ownerEvents(fixture: WorkFixture) {
  const pubkey = fixture.agents.gilfoyle.pubkey;
  return [
    mockEvent({
      id: "b1".repeat(32),
      kind: 30177,
      pubkey: fixture.viewer,
      tags: [["d", pubkey]],
      content: JSON.stringify({
        name: "Gilfoyle",
        model: "opus",
        respond_to: "owner-only",
      }),
    }),
    mockEvent({
      id: "b2".repeat(32),
      kind: 30180,
      pubkey: fixture.viewer,
      tags: [["d", "crichton.local"]],
      content: JSON.stringify({
        format: "buzz-desktop-catalog",
        version: 4,
        machine: "crichton.local",
        agents: [pubkey],
        harnesses: [],
        updated_at: Math.floor(Date.now() / 1000) - 120,
      }),
    }),
  ];
}
async function settings(page: Page, owner = true, target = "/repos/settings") {
  const fixture = buildWorkFixture();
  const requests = new Set<number>();
  const events = fixture.events.filter(
    (event) => owner || ![30177, 30180].includes(event.kind),
  );
  // The non-owner fixture contains valid foreign records, but no own records.
  const extra = ownerEvents(fixture).map((event) =>
    owner ? event : { ...event, pubkey: fixture.agents.acid.pubkey },
  );
  await page.addInitScript(() => {
    localStorage.setItem("buzz-theme", "buzz-dark");
    localStorage.setItem("buzz-follow-system", "false");
  });
  await routeUsageHub(page);
  await installMockRelay(page, [...events, ...extra], {
    onFrame: (frame) => {
      if (frame[0] === "REQ")
        for (const filter of frame.slice(2)) {
          for (const kind of (filter as { kinds?: number[] }).kinds ?? [])
            requests.add(kind);
        }
    },
  });
  await signIn(page, "/repos", fixture.viewerKey);
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  await expect(
    page.getByTestId(phone ? "phone-tab-bar" : "channel-sidebar"),
  ).toBeVisible();
  await page.goto(target);
  await expect
    .poll(() => requests.has(30177) && requests.has(30180))
    .toBe(true);
  return fixture;
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
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

test("W6 owner lands on Agents, footer flags a pre-P0 desktop, gilf Enter opens the target", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const fixture = await settings(page);
  await expect(page.getByTestId("settings-pane-agents")).toBeVisible();
  await expect(
    page.getByTestId("desktop-connection-footer").first(),
  ).toContainText("Buzz Desktop · crichton");
  // A v4 catalog cannot answer pings (PLAN §6 P0): never "online".
  await expect(
    page.getByTestId("desktop-connection-footer").first(),
  ).toContainText("status unknown — update Buzz Desktop");
  await expect(
    page.getByTestId("desktop-connection-footer").first(),
  ).not.toContainText(/online/i);
  await expect(
    page.getByRole("button", { name: "New agent", exact: true }).first(),
  ).toBeVisible();
  await screenshot(page, "w6-settings-1440");
  await page
    .getByRole("textbox", { name: "Search settings" })
    .first()
    .fill("gilf");
  await page
    .getByRole("textbox", { name: "Search settings" })
    .first()
    .press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`group=agents&agent=${fixture.agents.gilfoyle.pubkey}`),
  );
  await expect(page.getByTestId("agent-header")).toContainText("Gilfoyle");
  await page.getByRole("button", { name: "← Agents", exact: true }).click();
  await expect(page.getByTestId("agent-screen")).toHaveCount(0);
});
test("W6 non-owner lands on Account and explicit Account links survive owner landing", async ({
  page,
}) => {
  await settings(page, false);
  await expect(page.getByTestId("settings-pane-account")).toBeVisible();
  await expect(
    page.getByTestId("desktop-connection-footer").first(),
  ).toContainText("No Buzz Desktop report yet.");
});
test("W6 explicit Account link keeps Account for an owner", async ({
  page,
}) => {
  await settings(page, true, "/repos/settings?group=account");
  await expect(page.getByTestId("settings-pane-account")).toBeVisible();
});
test("W6 /repos/agents redirects to group=agents", async ({ page }) => {
  await settings(page, true, "/repos/agents");
  await expect(page).toHaveURL(/\/repos\/settings\?group=agents$/);
  await expect(page.getByTestId("settings-pane-agents")).toBeVisible();
});
test("W6 Library and moved sections remain reachable in Settings", async ({
  page,
}) => {
  await settings(page);
  const nav = page.getByRole("navigation", { name: "Settings" });
  await nav.getByTestId("settings-nav-item-library").click();
  await expect(page.getByTestId("settings-pane-library")).toContainText(
    "Agent definitions",
  );
  await page.getByRole("tab", { name: "Teams", exact: true }).click();
  await expect(page.getByTestId("settings-pane-library")).toContainText(
    "Agent teams",
  );
  for (const group of ["accounts", "voice", "channels", "advanced"]) {
    await nav.getByTestId(`settings-nav-item-${group}`).click();
    await expect(page.getByTestId(`settings-pane-${group}`)).toBeVisible();
  }
  await expect(page.getByTestId("settings-pane-advanced")).toContainText(
    "Keep awake, Git Bash and build options live in Buzz Desktop.",
  );
});
test("W6 390 phone root shows Agents first, hides Keyboard, drills in and returns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settings(page);
  const root = page.getByTestId("settings-root-list");
  await expect(root).toBeVisible();
  await expect(
    root.locator("button[data-testid^='settings-nav-item-']").first(),
  ).toHaveText("Agents");
  await expect(root.getByTestId("settings-nav-item-keyboard")).toHaveCount(0);
  await expect(root.getByTestId("desktop-connection-footer")).toContainText(
    "status unknown — update Buzz Desktop",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const row = await root.getByTestId("settings-nav-item-agents").boundingBox();
  expect(row?.height).toBeGreaterThanOrEqual(44);
  await screenshot(page, "w6-settings-390");
  await root.getByTestId("settings-nav-item-agents").click();
  await expect(page.getByTestId("settings-pane-agents")).toBeVisible();
  await page.getByRole("button", { name: "← Settings", exact: true }).click();
  await expect(root).toBeVisible();
  await root.getByRole("textbox", { name: "Search settings" }).fill("gilf");
  await root.getByRole("textbox", { name: "Search settings" }).press("Enter");
  await expect(page.getByTestId("agent-header")).toContainText("Gilfoyle");
});
test("W6 old agent link also redirects on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settings(page, true, "/repos/agents");
  await expect(page).toHaveURL(/\/repos\/settings\?group=agents$/);
  await expect(page.getByTestId("settings-pane-agents")).toBeVisible();
});
