import { expect, type Page, test } from "@playwright/test";

import { artboardItems, itemId, manyItems } from "./helpers/itemsFixture";
import type { MockEvent } from "./helpers/mockRelay";
import {
  channelPath,
  mainComposer,
  openShell,
  shot,
} from "./helpers/shellPage";

/**
 * Web redesign Phase 5 — Items — driven through the real sign-in against the
 * mocked relay: the Items page (tabs, filters, the table, the inline
 * expansion, the selection bar, a phone list), what its buttons publish
 * (handoff, owner, status, type, scratch channel), and `/bug` · `/backlog`
 * from the composer with their confirmation row.
 *
 * The mock is not a relay: it proves what the CLIENT sends and draws. Whether
 * the relay accepts kind 30623 is the live check's job.
 *
 * `SHOTS_DIR` writes the Items / Commands comparison frames at 1440 and 390
 * in both fixed palettes.
 */

const id = (seed: string) => itemId(seed);
const row = (page: Page, seed: string) =>
  page.getByTestId(`item-row-${id(seed)}`);
const expand = (page: Page, seed: string) =>
  row(page, seed).getByTestId("item-expand").click();
const tag = (event: MockEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name);

/** The bridge, answered in the page: its only caller is the summary line. */
async function routeSummaryBridge(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/summarize", async (route) => {
    asked.push(JSON.parse(route.request().postData() ?? "{}").text ?? "");
    await route.fulfill({
      json: {
        summary:
          "Round-2 cards fold into round 1's thread, which the phone Asks list never reads.",
      },
    });
  });
  return asked;
}

/** Collapse the docked Work rail, as the artboard frames the page. */
async function collapseWork(page: Page): Promise<void> {
  const collapse = page.getByRole("button", { name: "Collapse Work" });
  if (await collapse.isVisible().catch(() => false)) {
    await collapse.click();
  }
}

/** A relay fans a stored event out to the subscriptions that match it. */
const echo: NonNullable<Parameters<typeof openShell>[1]["relay"]> = {
  onPublish: (event, relay) => {
    if (event.kind === 9 || event.kind === 30623 || event.kind === 5) {
      relay.push(event);
    }
  },
};

/**
 * Sign in on a conversation (1440) or on Work (390), answer the summary
 * bridge, then open Items the way a person does: the sidebar row, or More.
 * The bridge route goes in AFTER sign-in so it outranks the Work fixture's.
 */
async function openItems(
  page: Page,
  theme: string,
  options: {
    extra?: "many";
    relay?: Parameters<typeof openShell>[1]["relay"];
    phone?: boolean;
  } = {},
) {
  const opened = await openShell(page, {
    theme,
    path: options.phone ? () => "/repos?view=work" : channelPath("flight-path"),
    fixture: { phase2: true },
    relay: options.relay ?? echo,
    extra: (fixture) =>
      options.extra === "many"
        ? manyItems(fixture, 150)
        : artboardItems(fixture).events,
  });
  const asked = await routeSummaryBridge(page);
  if (options.phone) {
    await page
      .getByTestId("phone-tab-bar")
      .getByRole("button", { name: "More" })
      .click();
    await page
      .getByTestId("phone-more-sheet")
      .getByRole("button", { name: "Items" })
      .click();
  } else {
    await page
      .getByTestId("channel-sidebar")
      .getByRole("button", { name: /^Items/ })
      .click();
  }
  await expect(page.getByTestId("items-page")).toBeVisible();
  return { ...opened, asked };
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`Items at 1440 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 1040 } });

    test("the table: tabs, counts, fold, AI summary, expansion and the selection bar", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const { fixture, asked } = await openItems(page, theme);
      await collapseWork(page);
      const itemsPage = page.getByTestId("items-page");
      await expect(itemsPage).toHaveAttribute("data-layout", "wide");

      // 13 items; one is done, so Not done shows 12: 4 bugs, 8 backlog.
      await expect(page.getByTestId("items-tab-all")).toContainText("12");
      await expect(page.getByTestId("items-tab-bug")).toContainText("4");
      await expect(page.getByTestId("items-tab-backlog")).toContainText("8");
      await expect(page.getByTestId("sidebar-items-counts")).toHaveText(
        "4 · 8",
      );

      // Newest filed first.
      const order = await page
        .locator('[data-testid^="item-row-"]')
        .evaluateAll((rows) =>
          rows.map((el) => (el as HTMLElement).dataset.testid ?? ""),
        );
      expect(order.slice(0, 5)).toEqual(
        ["86", "85", "87", "88", "83"].map((seed) => `item-row-${id(seed)}`),
      );

      // Two heads for 87: the newer one (Cereal Killer picked it up) wins.
      await expect(row(page, "87")).toContainText("Cereal Killer");
      await expect(row(page, "87").getByTestId("item-status")).toHaveText(
        "In progress",
      );
      // A channel-less item shows no channel rather than a dash.
      await expect(row(page, "76")).not.toContainText("—");

      // 84 has no summary tag: its long source message went to the bridge,
      // and the answer is marked AI.
      await expect(row(page, "84").getByTestId("item-summary")).toContainText(
        "which the phone Asks list never reads",
      );
      await expect(row(page, "84").getByTestId("item-summary")).toContainText(
        "AI",
      );
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("Round 2 of the card lands in the thread");

      // Expand 88: what it was captured from, and how to work it.
      await expand(page, "88");
      const detail = row(page, "88").getByTestId("item-detail");
      await expect(detail).toContainText("Captured from");
      await expect(detail).toContainText(
        "Typing in #flight-path, then /new, loses everything in the box.",
      );
      await expect(detail).toContainText("changed 14m ago by Acid Burn");
      await expect(
        detail.getByRole("button", { name: "Hand to an agent…" }),
      ).toBeEnabled();
      await expect(
        detail.getByRole("button", { name: "Move to backlog" }),
      ).toBeVisible();

      // Select two: the bar says so.
      await row(page, "84").getByRole("checkbox").check();
      await row(page, "79").getByRole("checkbox").check();
      await expect(page.getByTestId("items-bulk-bar")).toContainText(
        "2 selected",
      );
      await shot(page, `items-1440-${theme}`);

      await page.getByRole("button", { name: "Clear selection" }).click();
      await expect(page.getByTestId("items-bulk-bar")).toHaveCount(0);
      expect(fixture.viewer).toBeTruthy();
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe(`Items on a phone · ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("390 is a list, not a table, and still expands and selects", async ({
      page,
    }) => {
      await openItems(page, theme, { phone: true });
      const itemsPage = page.getByTestId("items-page");
      await expect(itemsPage).toHaveAttribute("data-layout", "narrow");
      // No column header, no horizontal scroll.
      await expect(itemsPage.getByText("Source channel")).toHaveCount(0);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const card = row(page, "88");
      await expect(card).toContainText(
        "Composer drops the draft when switching into a scratch channel",
      );
      await expect(card).toContainText("#flight-path");
      await card.getByTestId("item-expand").click();
      await expect(card.getByTestId("item-detail")).toContainText(
        "Captured from",
      );
      await shot(page, `items-390-${theme}`);
      await row(page, "86").getByRole("checkbox").check();
      await expect(page.getByTestId("items-bulk-bar")).toContainText(
        "1 selected",
      );
      await shot(page, `items-390-selected-${theme}`);
    });
  });
}

test.describe("Items: what the buttons publish", () => {
  test.use({ viewport: { width: 1440, height: 1040 } });

  test("filters: tab, owner, status, project and the text box", async ({
    page,
  }) => {
    await openItems(page, "buzz");
    await collapseWork(page);
    const rows = page.locator('[data-testid^="item-row-"]');
    await expect(rows).toHaveCount(12);
    await page.getByTestId("items-tab-bug").click();
    await expect(rows).toHaveCount(4);
    await page.getByTestId("items-tab-all").click();

    await page.getByTestId("items-filter-text").fill("@gilfoyle");
    await expect(rows).toHaveCount(3);
    await page.getByTestId("items-filter-text").fill("#ops");
    await expect(rows).toHaveCount(2);
    await page.getByTestId("items-filter-text").fill("");

    await page.getByTestId("items-filter-status").click();
    await page.getByRole("menuitem", { name: "Done", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(row(page, "77")).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByTestId("items-filter-status").click();
    await page.getByRole("menuitem", { name: "Not done", exact: true }).click();

    await page.getByTestId("items-filter-project").click();
    await page.getByRole("menuitem", { name: "Evals" }).click();
    await expect(rows).toHaveCount(1);
    await expect(row(page, "85")).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByTestId("items-filter-project").click();
    await page.getByRole("menuitem", { name: "All projects" }).click();

    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByTestId("items-filter-owner").click();
    await page.getByRole("menuitem", { name: "Nobody yet" }).click();
    await expect(rows).toHaveCount(6);
    await page.getByTestId("items-filter-text").fill("zzzz nothing");
    await expect(
      page.getByText("Nothing matches these filters."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(12);
  });

  test("Hand to an agent posts a handoff in the source channel and sets the owner", async ({
    page,
  }) => {
    const { fixture, relay } = await openItems(page, "buzz");
    await collapseWork(page);
    const flight = fixture.channels["flight-path"];
    await expand(page, "86");
    await row(page, "86")
      .getByRole("button", { name: "Hand to an agent…" })
      .click();
    const dialog = page.getByTestId("handoff-dialog");
    await expect(dialog).toContainText("#flight-path");
    // Only agents who are members of #flight-path are offered.
    await expect(dialog.getByText("Acid Burn")).toBeVisible();
    await expect(dialog.getByText("Crash Override")).toHaveCount(0);
    await dialog.getByText("Acid Burn").click();
    await dialog
      .getByPlaceholder("Anything to add? (optional)")
      .fill("Keep the roster copy as it is.");
    await dialog.getByRole("button", { name: "Hand off" }).click();
    await expect(dialog).toHaveCount(0);

    const handoff = relay.published.find(
      (event) => event.kind === 9 && tag(event, "handoff"),
    );
    expect(handoff).toBeTruthy();
    expect(tag(handoff as MockEvent, "h")?.[1]).toBe(flight);
    expect(tag(handoff as MockEvent, "handoff")?.[1]).toBe(
      fixture.agents.acid.pubkey,
    );
    expect(handoff?.content).toBe(
      `@Acid Burn please take backlog ${id("86")}: Scratch channels keep the parent's pinned agents\n\nKeep the roster copy as it is.`,
    );
    const head = relay.published.find((event) => event.kind === 30623);
    expect(head).toBeTruthy();
    const tags = (head as MockEvent).tags;
    expect(tags).toContainEqual(["d", id("86")]);
    expect(tags).toContainEqual(["h", flight]);
    expect(tags).toContainEqual(["p", fixture.agents.acid.pubkey, "", "owner"]);
    expect(tags).toContainEqual(["p", fixture.viewer, "", "reporter"]);
    await expect(row(page, "86")).toContainText("Acid Burn");
  });

  test("Mark done, flip type and the bulk bar publish the next head", async ({
    page,
  }) => {
    const { relay } = await openItems(page, "buzz");
    await collapseWork(page);
    const heads = () => relay.published.filter((event) => event.kind === 30623);

    await expand(page, "83");
    await row(page, "83")
      .getByRole("button", { name: "Make it a bug" })
      .click();
    await expect.poll(() => heads().length).toBe(1);
    expect(heads()[0].tags).toContainEqual(["type", "bug"]);
    await expect(page.getByTestId("items-tab-bug")).toContainText("5");
    await row(page, "83").getByRole("button", { name: "Mark done" }).click();
    await expect.poll(() => heads().length).toBe(2);
    expect(heads()[1].tags).toContainEqual(["status", "done"]);
    // The identity tags ride along unchanged.
    const created = heads()[0].tags.find((entry) => entry[0] === "created");
    expect(heads()[1].tags).toContainEqual(created);
    expect(heads()[1].created_at).toBeGreaterThan(heads()[0].created_at - 1);
    await expect(row(page, "83")).toHaveCount(0);

    await row(page, "80").getByRole("checkbox").check();
    await row(page, "78").getByRole("checkbox").check();
    await page
      .getByTestId("items-bulk-bar")
      .getByRole("button", { name: "Mark done" })
      .click();
    await expect.poll(() => heads().length).toBe(4);
    for (const seed of ["80", "78"]) {
      const next = heads().find((event) =>
        event.tags.some((entry) => entry[0] === "d" && entry[1] === id(seed)),
      );
      expect(next?.tags).toContainEqual(["status", "done"]);
      await expect(row(page, seed)).toHaveCount(0);
    }
    await expect(page.getByTestId("items-bulk-bar")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-items-counts")).toHaveText("4 · 5");
  });

  test("Open a scratch channel creates one for the item and posts it there", async ({
    page,
  }) => {
    const { relay } = await openItems(page, "buzz");
    await collapseWork(page);
    await expand(page, "86");
    await row(page, "86")
      .getByRole("button", { name: "Open a scratch channel for it" })
      .click();
    await expect
      .poll(() => relay.published.some((event) => event.kind === 9007), {
        timeout: 10_000,
      })
      .toBe(true);
    const create = relay.published.find((event) => event.kind === 9007);
    expect(tag(create as MockEvent, "name")?.[1]).toBe(
      `flight-path-backlog-${id("86").slice(0, 5)}`,
    );
    const scratchId = tag(create as MockEvent, "h")?.[1];
    await expect
      .poll(
        () =>
          relay.published.find(
            (event) => event.kind === 9 && tag(event, "h")?.[1] === scratchId,
          )?.content ?? "",
        { timeout: 15_000 },
      )
      .toBe(
        `Scratch channel for backlog ${id("86")}: Scratch channels keep the parent's pinned agents\n\n/new copies members and agents only, never history.`,
      );
  });
});

test.describe("/bug and /backlog", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  for (const theme of ["buzz", "buzz-dark"] as const) {
    test(`/bug files an item, posts the row that links it, and Open lands on it · ${theme}`, async ({
      page,
    }) => {
      const { fixture, relay } = await openShell(page, {
        theme,
        path: channelPath("flight-path"),
        fixture: { phase2: true },
        relay: echo,
        extra: (f) => artboardItems(f).events,
      });
      await expect(page.getByTestId("sidebar-items-counts")).toHaveText(
        "4 · 8",
      );
      const composer = mainComposer(page);
      await composer.click();
      await composer.fill("/b");
      const list = page.getByRole("listbox", { name: "Commands" });
      await expect(list).toContainText("File a bug in Buzz web");
      await expect(list).toContainText("Add an item to the Buzz web backlog");
      await shot(page, `commands-bug-${theme}`, { keepToasts: true });
      await composer.fill("/bug Composer loses focus after /exit");
      await composer.press("Enter");
      await expect(composer).toHaveValue("");

      await expect
        .poll(() => relay.published.filter((event) => event.kind === 9).length)
        .toBe(1);
      const kinds = relay.published.map((event) => event.kind);
      // The item goes out first; the row that links it second.
      expect(kinds.indexOf(30623)).toBeLessThan(kinds.indexOf(9));
      const head = relay.published.find(
        (event) => event.kind === 30623,
      ) as MockEvent;
      const confirmation = relay.published.find(
        (event) => event.kind === 9,
      ) as MockEvent;
      const d = tag(head, "d")?.[1] ?? "";
      expect(head.tags).toContainEqual(["e", confirmation.id, "", "source"]);
      expect(head.tags).toContainEqual(["h", fixture.channels["flight-path"]]);
      expect(head.tags).toContainEqual(["type", "bug"]);
      expect(head.tags).toContainEqual(["status", "open"]);
      expect(head.tags).toContainEqual(["project", "Buzz web"]);
      expect(confirmation.tags).toContainEqual(["item", d, "bug"]);
      expect(confirmation.tags).toContainEqual([
        "a",
        `30623:${fixture.viewer}:${d}`,
      ]);
      expect(confirmation.content).toBe(
        `Filed bug ${d}: Composer loses focus after /exit`,
      );

      // The row, drawn from the item — and the item is counted.
      const rowEl = page.getByTestId("item-confirmation");
      await expect(rowEl).toContainText("Filed a Buzz web bug");
      await expect(rowEl).toContainText("Composer loses focus after /exit");
      const state = rowEl.getByTestId("item-confirmation-state");
      await expect(state).toContainText("Open");
      await expect(state).toContainText("no owner");
      await expect(page.getByTestId("sidebar-items-counts")).toHaveText(
        "5 · 8",
      );
      await shot(page, `commands-bug-row-${theme}`, { keepToasts: true });

      await rowEl.getByRole("button", { name: "View ↗" }).click();
      await expect(page.getByTestId("items-page")).toBeVisible();
      const itemRow = page.getByTestId(`item-row-${d}`);
      await expect(itemRow).toBeVisible();
      await expect(itemRow.getByTestId("item-detail")).toBeVisible();
    });
  }

  test("a refused item says why, keeps the draft, and posts no row", async ({
    page,
  }) => {
    const { relay } = await openShell(page, {
      theme: "buzz",
      path: channelPath("flight-path"),
      fixture: { phase2: true },
      relay: {
        rejectPublish: (event) =>
          event.kind === 30623 ? "invalid: unknown event kind" : null,
      },
    });
    const composer = mainComposer(page);
    await composer.click();
    await composer.fill("/backlog Scratch channels keep pinned agents");
    await composer.press("Enter");
    await expect(page.getByText("invalid: unknown event kind")).toBeVisible();
    await expect(composer).toHaveValue(
      "/backlog Scratch channels keep pinned agents",
    );
    expect(relay.published.filter((event) => event.kind === 9)).toHaveLength(0);
    expect(
      relay.published.filter((event) => event.kind === 30623),
    ).toHaveLength(1);
  });

  test("Undo takes the item and its row back", async ({ page }) => {
    const { relay } = await openShell(page, {
      theme: "buzz",
      path: channelPath("flight-path"),
      fixture: { phase2: true },
      relay: echo,
    });
    const composer = mainComposer(page);
    await composer.click();
    await composer.fill("/backlog Remember the last filter on Items");
    await composer.press("Enter");
    const undo = page.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect
      .poll(() => relay.published.filter((event) => event.kind === 5).length)
      .toBe(2);
    const head = relay.published.find(
      (event) => event.kind === 30623,
    ) as MockEvent;
    const confirmation = relay.published.find(
      (event) => event.kind === 9,
    ) as MockEvent;
    const deleted = relay.published
      .filter((event) => event.kind === 5)
      .map((event) => tag(event, "e")?.[1]);
    expect(deleted).toEqual([head.id, confirmation.id]);
  });
});

test.describe("150 items", () => {
  test.use({ viewport: { width: 1440, height: 1040 } });

  test("the 150-item fixture filters in under 100 ms", async ({ page }) => {
    await openItems(page, "buzz", { extra: "many" });
    await collapseWork(page);
    // 150 items, 37 done: 113 shown under Not done, 60 drawn per page.
    await expect(page.getByTestId("items-tab-all")).toContainText("113");
    await expect(page.locator('[data-testid^="item-row-"]')).toHaveCount(60);
    const timings = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="items-filter-text"]',
      );
      if (!input) {
        throw new Error("no filter box");
      }
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      const count = () =>
        document.querySelectorAll('[data-testid^="item-row-"]').length;
      const measure = async (text: string) => {
        const before = count();
        const started = performance.now();
        setValue?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise<void>((resolve) => {
          const check = () =>
            count() !== before ? resolve() : requestAnimationFrame(check);
          check();
        });
        return { text, ms: performance.now() - started, rows: count() };
      };
      return [
        await measure("composer"),
        await measure("composer draft item 1"),
        await measure(""),
        await measure("#ops"),
      ];
    });
    for (const timing of timings) {
      expect(
        timing.ms,
        `${timing.text}: ${timing.ms.toFixed(1)} ms`,
      ).toBeLessThan(100);
    }
    expect(timings[0].rows).toBeGreaterThan(0);
    console.log(
      `filter timings: ${timings.map((t) => `${t.text || "(clear)"}=${t.ms.toFixed(1)}ms/${t.rows}`).join(", ")}`,
    );
  });
});
