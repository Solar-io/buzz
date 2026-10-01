import { readFileSync } from "node:fs";

import { expect, type Frame, type Page, test } from "@playwright/test";

import {
  channelPath as shellChannelPath,
  openShell as open,
  shot,
} from "./helpers/shellPage";

/**
 * Files embedded (web redesign Phase 4, Files artboard), end to end: the
 * sidebar's Files row shows the Files site in the MAIN column with the
 * folded Work strip beside it — not over the whole row — the site gets
 * Buzz's theme pushed on its `files:ready`, and Escape returns to the
 * conversation.
 *
 * The Files site is a stand-in served by the route below that speaks the
 * stash side of the §4.2 contract: it announces `files:ready` to its parent
 * and records every `buzz:theme` it receives.
 */

const FILES_URL = "https://files.e2e.test/";
const FILES_PAGE = `<!doctype html><html><body style="margin:0">
<main>stash stand-in</main>
<script>
  window.__themes = [];
  addEventListener("message", (event) => {
    if (event.data && event.data.type === "buzz:theme") {
      window.__themes.push({
        origin: event.origin,
        mode: event.data.mode,
        background: event.data.tokens.background,
      });
    }
  });
  parent.postMessage({ type: "files:ready", v: 1 }, "*");
</script></body></html>`;

/** The Files default the production build bakes in (web/.env.production). */
function bakedFilesUrl(): string {
  try {
    const env = readFileSync(
      new URL("../../.env.production", import.meta.url),
      "utf8",
    );
    return env.match(/^VITE_FILES_PANEL_URL=(.+)$/m)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

async function filesFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(FILES_URL)))
    .toBe(true);
  const frame = page.frames().find((f) => f.url().startsWith(FILES_URL));
  if (!frame) {
    throw new Error("the Files frame never loaded");
  }
  return frame;
}

test.describe("desktop 1440 · buzz · Files", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("Files opens in the main column beside the Work strip, themed, and Escape closes it", async ({
    page,
  }) => {
    await page.route(`${FILES_URL}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: FILES_PAGE,
      }),
    );
    await page.addInitScript((url) => {
      localStorage.setItem("buzz:files-url.v2", url);
    }, FILES_URL);
    await open(page, { theme: "buzz", path: shellChannelPath() });
    await expect(page.getByTestId("work-rail")).toBeVisible();

    const filesRow = page
      .getByTestId("app-shell-sidebar")
      .getByRole("button", { name: "Files", exact: true });
    await filesRow.click();

    const host = page.getByTestId("web-frame-host");
    await expect(host).toHaveAttribute("data-active", "files:files");
    await expect(filesRow).toHaveAttribute("data-active", "true");
    const frame = page.getByTestId("web-panel-frame-files:files");
    await expect(frame).toBeVisible();

    // Main column: the Work strip stays, to the RIGHT of Files.
    const strip = page.getByTestId("work-rail-collapsed");
    await expect(strip).toBeVisible();
    const frameBox = await frame.boundingBox();
    const stripBox = await strip.boundingBox();
    expect(frameBox && stripBox).toBeTruthy();
    if (frameBox && stripBox) {
      expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(stripBox.x + 1);
      expect(stripBox.width).toBe(48);
    }

    // The theme answered files:ready, from Buzz's own origin.
    const files = await filesFrame(page);
    await expect
      .poll(() =>
        files.evaluate(
          () => (window as unknown as { __themes: unknown[] }).__themes.length,
        ),
      )
      .toBeGreaterThan(0);
    const first = await files.evaluate(
      () => (window as unknown as { __themes: unknown[] }).__themes[0],
    );
    // buzz-light's --background (45 50.00% 98.4%); Chrome re-serializes the
    // resolved custom property, so "50.00%" may arrive as "50.0%".
    expect(first).toEqual({
      origin: new URL(page.url()).origin,
      mode: "light",
      background: expect.stringMatching(/^hsl\(45 50(\.0+)?% 98\.4%\)$/),
    });
    await shot(page, "files-buzz-1440");

    // Escape backs out to the conversation; the Work rail docks again.
    await page.keyboard.press("Escape");
    await expect(host).toHaveAttribute("data-active", "");
    await expect(page.getByTestId("work-rail")).toBeVisible();
    await expect(filesRow).toHaveAttribute("data-active", "false");
  });

  test("a legacy per-browser Files URL does not shadow the build default", async ({
    page,
  }) => {
    // The deployed build bakes VITE_FILES_PANEL_URL (.env.production). A
    // browser that saved a URL under the pre-default key — Sam's held the
    // retired :6201 file manager — must still get the baked default.
    const baked = bakedFilesUrl();
    test.skip(!baked, "this build has no VITE_FILES_PANEL_URL default");
    await page.route("https://retired.e2e.test/**", (route) =>
      route.fulfill({ status: 502, body: "retired" }),
    );
    await page.route(`${baked}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: FILES_PAGE,
      }),
    );
    await page.addInitScript(() => {
      try {
        localStorage.setItem("buzz:files-url", "https://retired.e2e.test/");
      } catch {
        // A sandboxed frame: nothing to seed.
      }
    });
    await open(page, { theme: "buzz", path: shellChannelPath() });
    await page
      .getByTestId("app-shell-sidebar")
      .getByRole("button", { name: "Files", exact: true })
      .click();
    const frame = page.getByTestId("web-panel-frame-files:files");
    await expect(frame).toBeVisible();
    const src = (await frame.getAttribute("src")) ?? "";
    expect(src.startsWith(baked), src).toBe(true);
    expect(
      await page.evaluate(() => localStorage.getItem("buzz:files-url")),
    ).toBeNull();
  });
});
