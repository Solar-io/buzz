import { expect, type Page, test } from "@playwright/test";

import type { MockEvent, MockRelayOptions } from "./helpers/mockRelay";
import {
  pdfShare,
  probeShare,
  RTS_DIR,
  routeShelfMedia,
  shelfEvents,
} from "./helpers/shelfFixture";
import { channelPath, openShell, shot } from "./helpers/shellPage";
import type { WorkFixture } from "./helpers/workFixture";

/**
 * Web redesign Phase 6 — the Shelf, file tabs and file tiles — driven
 * through the real sign-in against the mocked relay, with each shared
 * file's bytes served at its media URL so every previewer runs on real
 * bytes through the signed GET.
 *
 * The mock is not a relay: it proves what the CLIENT queries, draws and
 * publishes. The `#t` pushdown and the relay's attachment headers are the
 * backend half's tests.
 *
 * `SHOTS_DIR` writes the Shelf / Preview / phone frames at 1440 and 390 in
 * both fixed palettes.
 */

const FILES_URL = "https://crichton.e2e.test/";

/** A relay fans a stored chat message out to the subscriptions that match. */
const echo: MockRelayOptions = {
  onPublish: (event, relay) => {
    if (event.kind === 9) {
      relay.push(event);
    }
  },
};

async function open(
  page: Page,
  theme: string,
  options: {
    path?: (f: WorkFixture) => string;
    probe?: boolean;
    pdf?: boolean;
  } = {},
) {
  let seeded: ReturnType<typeof shelfEvents> | null = null;
  let probe: MockEvent | null = null;
  await page.addInitScript((url) => {
    try {
      localStorage.setItem("buzz:files-url", url);
    } catch {
      // Init scripts also run inside the sandboxed preview frame.
    }
  }, FILES_URL);
  const media = await routeShelfMedia(page);
  const opened = await openShell(page, {
    theme,
    path: options.path ?? channelPath("flight-path"),
    relay: echo,
    extra: (fixture) => {
      seeded = shelfEvents(fixture);
      probe = options.probe ? probeShare(fixture) : null;
      return [
        ...seeded.events,
        ...(probe ? [probe] : []),
        ...(options.pdf ? [pdfShare(fixture)] : []),
      ];
    },
  });
  if (!seeded) {
    throw new Error("the Shelf fixture was never built");
  }
  return {
    ...opened,
    media,
    shares: seeded as ReturnType<typeof shelfEvents>,
    probe: probe as MockEvent | null,
  };
}

async function openShelfFromSidebar(page: Page) {
  const row = page
    .getByTestId("channel-sidebar")
    .getByRole("button", { name: /^Shelf/ });
  await row.click();
  await expect(page.getByTestId("shelf-page")).toBeVisible();
}

const rowFor = (page: Page, title: string | RegExp) =>
  page
    .getByTestId("shelf-row")
    .filter({ has: page.getByTestId("shelf-row-title").getByText(title) });

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`Shelf at 1440 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 960 } });

    test("the Shelf: rows by day, chips with counts, filters, a file opens beside it with comments", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const { fixture, relay, media, shares } = await open(page, theme);

      // The sidebar says what arrived since the Shelf was last opened.
      await expect(
        page.getByTestId("channel-sidebar").getByTestId("sidebar-shelf-new"),
      ).toHaveText(/^\d+ new$/);
      await openShelfFromSidebar(page);
      const shelf = page.getByTestId("shelf-page");
      await expect(shelf).toHaveAttribute("data-layout", "wide");
      // Looking at it clears the badge.
      await expect(
        page.getByTestId("channel-sidebar").getByTestId("sidebar-shelf-new"),
      ).toHaveCount(0);

      // 7 shares, 10 files: newest first, grouped by day.
      await expect(page.getByTestId("shelf-row")).toHaveCount(7);
      await expect(shelf.getByRole("heading", { name: "Today" })).toBeVisible();
      await expect(
        shelf.getByRole("heading", { name: "Yesterday" }),
      ).toBeVisible();
      const titles = await page
        .getByTestId("shelf-row-title")
        .allTextContents();
      expect(titles.slice(0, 2)).toEqual([
        "bakeoff-results.md",
        "rts-bakeoff / game-A…D.html",
      ]);
      await expect(page.getByTestId("shelf-type-all")).toContainText("10");
      await expect(page.getByTestId("shelf-type-web")).toContainText("5");
      await expect(page.getByTestId("shelf-type-docs")).toContainText("2");
      await expect(page.getByTestId("shelf-type-images")).toContainText("1");
      await expect(page.getByTestId("shelf-type-data")).toContainText("2");
      // No code was shared: no "Code 0" chip.
      await expect(page.getByTestId("shelf-type-code")).toHaveCount(0);
      // Shared in, From: the DM reads as a DM.
      await expect(rowFor(page, "bakeoff-results.md")).toContainText(
        "DM Gilfoyle",
      );
      await expect(rowFor(page, "beat-02-capture.png")).toContainText(
        "#flight-path",
      );

      // Open the write-up: a file tab beside Work, the markdown rendered.
      await rowFor(page, "bakeoff-results.md").click();
      const tabs = page.getByTestId("right-pane-tabs");
      await expect(tabs.getByRole("tab", { name: "Work" })).toBeVisible();
      await expect(
        tabs.getByRole("tab", { name: "bakeoff-results.md" }),
      ).toHaveAttribute("aria-selected", "true");
      const preview = page.getByTestId("file-preview");
      await expect(
        preview.getByRole("heading", { name: "RTS bake-off: results" }),
      ).toBeVisible();
      await expect(preview).toContainText("Shared by Gilfoyle in DM Gilfoyle");
      await expect(preview.getByTestId("file-preview-path")).toHaveText(
        "crichton: ~/MEGA/shared_files/dropbox/rts-bakeoff/bakeoff-results.md",
      );
      expect(media).toContain("bakeoff-results.md");
      // The comment on a highlight, and the agent's answer folded under it.
      const comment = preview.getByTestId("file-comment");
      await expect(comment).toHaveCount(1);
      await expect(comment).toContainText("on the highlight");
      await expect(comment).toContainText("Top effort decided both");
      await expect(comment.getByTestId("file-comment-reply")).toContainText(
        "On it. Added to Items",
      );
      await expect(rowFor(page, "bakeoff-results.md")).toHaveClass(/bg-sunk/);
      expect(pageErrors).toEqual([]);
      await shot(page, `shelf-${theme}-1440`);

      // Source shows the bytes with line numbers.
      await preview.getByTestId("file-view-source").click();
      await expect(preview.getByTestId("file-code-view")).toContainText(
        "# RTS bake-off: results",
      );
      await preview.getByTestId("file-view-preview").click();

      // A comment is a thread reply to the share, and wakes its author.
      const box = preview.getByTestId("file-comment-input");
      await box.fill("Score C again with the audio fix.");
      await box.press("Enter");
      await expect
        .poll(() =>
          relay.published.find(
            (event) =>
              event.kind === 9 &&
              event.content === "Score C again with the audio fix.",
          ),
        )
        .toBeTruthy();
      const sent = relay.published.find(
        (event) => event.content === "Score C again with the audio fix.",
      ) as MockEvent;
      expect(sent.tags).toContainEqual(["h", fixture.channels["dm-gilfoyle"]]);
      // A top-level share is its own thread root: one reply marker.
      expect(sent.tags).toContainEqual(["e", shares.results.id, "", "reply"]);
      expect(sent.tags).toContainEqual(["p", fixture.agents.gilfoyle.pubkey]);
      await expect(preview.getByTestId("file-comment")).toHaveCount(2);

      // Type and sender filters.
      await page.getByTestId("shelf-type-web").click();
      await expect(page.getByTestId("shelf-row")).toHaveCount(2);
      await page.getByTestId("shelf-type-all").click();
      await page.getByTestId("shelf-filter-sender").click();
      await page.getByRole("menuitem", { name: "Lord Nikon" }).click();
      await expect(page.getByTestId("shelf-row")).toHaveCount(1);
      await expect(page.getByTestId("shelf-row")).toContainText(
        "beat-02-capture.png",
      );
      // Radix holds pointer events until the closing menu is gone.
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.getByTestId("shelf-filter-sender").click();
      await page.getByRole("menuitem", { name: "Anyone" }).click();
      await page.getByTestId("shelf-search").fill("snapshots");
      await expect(page.getByTestId("shelf-row")).toHaveCount(1);
      await page.getByTestId("shelf-search").fill("");

      // A multi-file share opens to its files; each opens its own tab.
      await rowFor(page, "rts-bakeoff / game-A…D.html").click();
      const files = page.getByTestId("shelf-row-files");
      await expect(files.getByRole("button")).toHaveCount(4);
      await files.getByRole("button", { name: /game-C\.html/ }).click();
      await expect(
        tabs.getByRole("tab", { name: "game-C.html" }),
      ).toHaveAttribute("aria-selected", "true");
      const frame = preview.getByTestId("html-preview-frame");
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      expect(await frame.getAttribute("src")).toBeNull();
      // The page RAN (scripts allowed) inside its sandbox.
      await expect(
        page
          .frameLocator('[data-testid="html-preview-frame"]')
          .locator("#state"),
      ).toHaveText("running");

      // Expand to full, then back.
      await page.getByTestId("file-expand").click();
      await expect(page.getByTestId("right-dock")).toHaveAttribute(
        "data-expanded",
        "true",
      );
      const dock = await page.getByTestId("right-dock").boundingBox();
      expect(dock?.width ?? 0).toBeGreaterThan(1000);
      await shot(page, `shelf-expanded-${theme}-1440`);
      await page.getByTestId("file-expand").click();
      await expect(page.getByTestId("right-dock")).not.toHaveAttribute(
        "data-expanded",
        "true",
      );

      // Closing the active tab goes left; Work is still the first tab.
      await tabs.getByRole("button", { name: "Close game-C.html" }).click();
      await expect(
        tabs.getByRole("tab", { name: "bakeoff-results.md" }),
      ).toHaveAttribute("aria-selected", "true");
      await tabs.getByRole("tab", { name: "Work" }).click();
      await expect(page.getByTestId("work-rail")).toBeVisible();
      expect(pageErrors).toEqual([]);
    });

    test("tiles in the conversation open files beside it; Jump and Open in Files", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route(`${FILES_URL}**`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><main>stash stand-in</main>",
        }),
      );
      const { shares } = await open(page, theme, {
        path: channelPath("dm-gilfoyle"),
      });

      // The four games: one tile group, its folder, the letters, the Shelf.
      const group = page.getByTestId("file-tile-group").last();
      await expect(group.getByTestId("file-tile")).toHaveCount(4);
      await expect(group.getByTestId("file-tile-group-folder")).toHaveText(
        "MEGA / shared_files / dropbox / rts-bakeoff",
      );
      await expect(group.getByTestId("file-tile").first()).toContainText("A");
      await expect(group).toContainText("Open in Shelf →");
      // The write-up: one card that says it is on the Shelf.
      const card = page.getByTestId("file-card").last();
      await expect(card).toContainText("bakeoff-results.md");
      await expect(card).toContainText("on the Shelf");

      await group.getByRole("button", { name: "Open game-C.html" }).click();
      const preview = page.getByTestId("file-preview");
      await expect(preview.getByTestId("file-preview-name")).toHaveText(
        "game-C.html",
      );
      await expect(
        group.getByRole("button", { name: "Open game-C.html" }),
      ).toContainText("open in pane →");
      await expect(
        page
          .frameLocator('[data-testid="html-preview-frame"]')
          .locator("#state"),
      ).toHaveText("running");
      expect(pageErrors).toEqual([]);
      // The clicked tile keeps focus, which raises its row's action bar.
      await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.blur(),
      );
      await shot(page, `preview-${theme}-1440`);

      // Open in Files: the path's host is the Files host, so Files opens on it.
      await preview.getByTestId("file-open-in-files").click();
      await expect
        .poll(() =>
          page
            .frames()
            .map((frame) => frame.url())
            .find((url) => url.startsWith(FILES_URL)),
        )
        .toContain(`path=${encodeURIComponent(`${RTS_DIR}/game-C.html`)}`);
      await page.keyboard.press("Escape");

      // The write-up's card opens its own tab; Jump lands on its message.
      await card.click();
      await expect(preview.getByTestId("file-preview-name")).toHaveText(
        "bakeoff-results.md",
      );
      // Jump to message navigates to the share (?c=&m=, which the shell
      // drops again once the row has landed — so catch the navigation).
      await Promise.all([
        page.waitForURL(new RegExp(`m=(%22)?${shares.results.id}`), {
          waitUntil: "commit",
        }),
        preview.getByTestId("file-jump").click(),
      ]);
    });
  });
}

test.describe("previewers", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("code through Shiki, CSV as a table, a PDF in the browser's viewer, an image", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await open(page, "buzz", { pdf: true });
    await openShelfFromSidebar(page);
    const preview = page.getByTestId("file-preview");

    await rowFor(page, "jitter-buffer-trace.json").click();
    const code = preview.getByTestId("file-code-view");
    await expect(code).toContainText('"verdict"');
    // Shiki coloured it: a token carries an inline colour.
    await expect(code.locator("span[style*='color']").first()).toBeVisible();
    // A highlighted file has nothing to switch to.
    await expect(preview.getByTestId("file-view-source")).toHaveCount(0);

    await rowFor(page, "pilot-snapshots-delete-list.csv").click();
    const table = preview.getByTestId("file-table-view");
    await expect(table.locator("th")).toHaveText([
      "snapshot",
      "host",
      "age_days",
      "size_gb",
    ]);
    // A quoted field with a comma stays one cell.
    await expect(table).toContainText("pilot-2026-08-29, pre-upgrade");
    await preview.getByTestId("file-view-source").click();
    await expect(preview.getByTestId("file-code-view")).toContainText(
      "snapshot,host,age_days,size_gb",
    );

    await rowFor(page, "capture-plan.pdf").click();
    const pdf = preview.getByTestId("file-pdf-view");
    await expect(pdf).toHaveAttribute("src", /^blob:/);

    await rowFor(page, "beat-02-capture.png").click();
    const image = preview.getByTestId("file-image-view");
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(320);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("HTML preview isolation", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("a shared page runs, but cannot read this app's storage or cookies", async ({
    page,
  }) => {
    const { probe } = await open(page, "buzz", { probe: true });
    // Something worth stealing, on the app's own origin.
    await page.evaluate(() => {
      localStorage.setItem("buzz-e2e-secret", "app-local-secret");
      sessionStorage.setItem("buzz-e2e-secret", "app-session-secret");
      // biome-ignore lint/suspicious/noDocumentCookie: planting the cookie the sandboxed preview must not be able to read
      document.cookie = "buzz_e2e_secret=app-cookie-secret; path=/";
      (window as unknown as { __probe: unknown[] }).__probe = [];
      window.addEventListener("message", (event) => {
        if (event.data?.type === "buzz-e2e-probe") {
          (window as unknown as { __probe: unknown[] }).__probe.push({
            origin: event.origin,
            out: event.data.out,
          });
        }
      });
    });
    expect(probe).not.toBeNull();
    // The secrets are really there for the app itself to read.
    expect(await page.evaluate(() => document.cookie)).toContain(
      "app-cookie-secret",
    );
    expect(
      await page.evaluate(() => localStorage.getItem("buzz-e2e-secret")),
    ).toBe("app-local-secret");
    await openShelfFromSidebar(page);
    await rowFor(page, "storage-probe.html").click();
    await expect(page.getByTestId("html-preview-frame")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __probe: unknown[] }).__probe.length,
        ),
      )
      .toBe(1);
    const [report] = (await page.evaluate(
      () => (window as unknown as { __probe: unknown[] }).__probe,
    )) as Array<{ origin: string; out: Record<string, string> }>;
    // The script ran (so the test can fail), in an OPAQUE origin.
    expect(report.out.origin).toBe("null");
    expect(report.origin).toBe("null");
    // Every way in is refused — none of them hands back the app's secrets.
    expect(report.out.localStorage).toBe("blocked:SecurityError");
    expect(report.out.sessionStorage).toBe("blocked:SecurityError");
    expect(report.out.cookie).toBe("blocked:SecurityError");
    expect(report.out.parentLocalStorage).toBe("blocked:SecurityError");
    expect(report.out.parentCookie).toBe("blocked:SecurityError");
    expect(report.out.parentTitle).toBe("blocked:SecurityError");
    expect(report.out.indexedDB).toBe("blocked:SecurityError");
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`Shelf on a phone · ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("390: More → Shelf is a list; a file opens as a full-screen sheet", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await open(page, theme, { path: () => "/repos?view=work" });
      await page
        .getByTestId("phone-tab-bar")
        .getByRole("button", { name: "More" })
        .click();
      await page
        .getByTestId("phone-more-sheet")
        .getByRole("button", { name: "Shelf" })
        .click();
      const shelf = page.getByTestId("shelf-page");
      await expect(shelf).toHaveAttribute("data-layout", "narrow");
      await expect(page.getByTestId("shelf-row")).toHaveCount(7);
      // No sideways scroll at phone width.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await shot(page, `shelf-390-${theme}`);

      await rowFor(page, "bakeoff-results.md").click();
      const sheet = page.getByTestId("file-preview-sheet");
      await expect(sheet).toBeVisible();
      await expect(
        sheet.getByRole("heading", { name: "RTS bake-off: results" }),
      ).toBeVisible();
      const box = await sheet.boundingBox();
      expect(box?.width).toBe(390);
      await expect(sheet.getByTestId("file-comment")).toHaveCount(1);
      await expect(sheet.getByTestId("file-comment-input")).toBeVisible();
      expect(pageErrors).toEqual([]);
      await shot(page, `shelf-sheet-390-${theme}`);

      // The image previewer, from the same list.
      await sheet.getByRole("button", { name: "Close file" }).click();
      await expect(sheet).toHaveCount(0);
      await rowFor(page, "beat-02-capture.png").click();
      await expect(
        page.getByTestId("file-preview-sheet").getByTestId("file-image-view"),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("file-preview-sheet")).toHaveCount(0);
    });
  });
}
