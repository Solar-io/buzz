import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { verifyEvent } from "nostr-tools/pure";
import { test } from "./helpers/agentBraveTest";
import { installMockRelay, mockEvent } from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";
import { buildWorkFixture, routeUsageHub } from "./helpers/workFixture";

const ID = "5489c60b-7db9-4702-8bf9-86caa5ab3527";
const PROMPT = " \nReview **literal** [links](https://iana.org).\n ";

async function definition(
  page: Page,
  width: number,
  theme = "dark",
  reject = false,
) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
  const fixture = buildWorkFixture();
  const original = mockEvent({
    id: "ba".repeat(32),
    pubkey: fixture.viewer,
    kind: 30175,
    tags: [
      ["d", ID],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: "W11b test definition",
      system_prompt: PROMPT,
      name_pool: ["Alice", "Bob"],
      runtime: "codex",
      x_future: { keep: true },
    }),
  });
  await page.addInitScript((theme) => {
    localStorage.setItem(
      "buzz-theme",
      theme === "light" ? "buzz" : "buzz-dark",
    );
    localStorage.setItem("buzz-follow-system", "false");
  }, theme);
  await routeUsageHub(page);
  const relay = await installMockRelay(
    page,
    [
      ...fixture.events.filter(
        (event) => ![30175, 30176, 30177, 30180].includes(event.kind),
      ),
      original,
    ],
    {
      rejectPublish: (event) =>
        reject && event.kind === 30175
          ? "restricted: test definition refused"
          : null,
      onPublish: (event, relay) => {
        if (event.kind === 30175) relay.push(event);
      },
    },
  );
  await signIn(page, "/repos", fixture.viewerKey);
  await expect(
    page.getByTestId(width === 390 ? "phone-tab-bar" : "channel-sidebar"),
  ).toBeVisible();
  await page.goto("/repos/settings?group=library");
  await expect(page.locator("html")).toHaveAttribute(
    "data-palette",
    `buzz-${theme}`,
  );
  await page.getByRole("button", { name: /W11b test definition/ }).click();
  await expect(page.getByLabel("Name pool", { exact: true })).toHaveValue(
    "Alice\nBob",
  );
  return {
    relay,
    original,
    writes: () => relay.published.filter((event) => event.kind === 30175),
  };
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
  const dir = path.resolve("../.scratch/w11b/screenshots");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    fullPage: true,
  });
  // The editor lives in its own scroll panel; photograph the controls too.
  await page.getByLabel("Name pool", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, `${name}-pool.png`) });
  await page
    .getByRole("button", { name: "Duplicate", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, `${name}-actions.png`) });
}

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`W11b saved name pool and private duplicate survive reload at ${width} ${theme}`, async ({
      page,
    }) => {
      const state = await definition(page, width, theme);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByLabel("Name pool", { exact: true })
        .fill("Charlie\nDana\nCharlie");
      await page
        .getByRole("button", { name: "Save definition", exact: true })
        .click();
      await expect.poll(() => state.writes().length).toBe(1);
      const saved = state.writes()[0];
      expect(verifyEvent(saved)).toBe(true);
      expect(JSON.parse(saved.content)).toEqual({
        ...JSON.parse(state.original.content),
        name_pool: ["Charlie", "Dana", "Charlie"],
      });
      expect(saved.tags).toEqual(state.original.tags);
      expect(saved.created_at).toBeGreaterThan(state.original.created_at);
      await page
        .getByRole("button", { name: "Duplicate", exact: true })
        .click();
      await expect.poll(() => state.writes().length).toBe(2);
      const copy = state.writes()[1];
      expect(verifyEvent(copy)).toBe(true);
      expect(copy.tags).toHaveLength(1);
      expect(copy.tags[0][0]).toBe("d");
      expect(copy.tags[0][1]).toMatch(
        /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
      );
      expect(copy.tags[0][1]).not.toBe(ID);
      expect(JSON.parse(copy.content)).toEqual({
        ...JSON.parse(saved.content),
        display_name: "W11b test definition (copy)",
      });
      await expect(
        page.getByLabel("Definition name", { exact: true }),
      ).toHaveValue("W11b test definition (copy)");
      await expect(page.getByLabel("Name pool", { exact: true })).toHaveValue(
        "Charlie\nDana\nCharlie",
      );
      await screenshot(page, `definition-${width}-${theme}`);
      await page
        .getByRole("button", { name: "All definitions", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: /W11b test definition \(copy\)/ }),
      ).toBeVisible();
      await page.reload();
      await page
        .getByRole("button", { name: /W11b test definition \(copy\)/ })
        .click();
      await expect(page.getByLabel("Name pool", { exact: true })).toHaveValue(
        "Charlie\nDana\nCharlie",
      );
      await page.getByLabel("Name pool", { exact: true }).fill("");
      await page
        .getByRole("button", { name: "Save definition", exact: true })
        .click();
      await expect.poll(() => state.writes().length).toBe(3);
      expect(JSON.parse(state.writes()[2].content).name_pool).toBeUndefined();
      expect(errors).toEqual([]);
    });
  }

  test(`W11b rejects bidi instructions without a publish at ${width}`, async ({
    page,
  }) => {
    const state = await definition(page, width);
    await page
      .getByLabel("Definition system prompt", { exact: true })
      .fill("Be \u202Ekind.");
    await page
      .getByRole("button", { name: "Save definition", exact: true })
      .click();
    await expect(
      page.getByText(
        "Agent instructions contains prohibited invisible or formatting character U+202E",
        { exact: true },
      ),
    ).toBeVisible();
    expect(state.writes()).toHaveLength(0);
    await expect(
      page.getByLabel("Definition system prompt", { exact: true }),
    ).toHaveValue("Be \u202Ekind.");
    await page
      .getByLabel("Definition system prompt", { exact: true })
      .fill(PROMPT);
    await page.getByLabel("Name pool", { exact: true }).fill("\uFEFFAlice");
    await page
      .getByRole("button", { name: "Save definition", exact: true })
      .click();
    await expect(
      page.getByText(
        "Name pool: Display name contains prohibited invisible or formatting character U+FEFF",
        { exact: true },
      ),
    ).toBeVisible();
    expect(state.writes()).toHaveLength(0);
  });

  test(`W11b relay refusals preserve the editor and never open a copy at ${width}`, async ({
    page,
  }) => {
    const state = await definition(page, width, "dark", true);
    await page.getByLabel("Name pool", { exact: true }).fill("Refused name");
    await page
      .getByRole("button", { name: "Save definition", exact: true })
      .click();
    await expect(
      page.getByText("restricted: test definition refused", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Name pool", { exact: true })).toHaveValue(
      "Refused name",
    );
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect.poll(() => state.writes().length).toBe(2);
    await expect(
      page.getByLabel("Definition name", { exact: true }),
    ).toHaveValue("W11b test definition");
  });
}
