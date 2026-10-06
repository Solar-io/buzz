import { createHash } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import type { MockEvent, MockRelayOptions } from "./helpers/mockRelay";
import { RTS_DIR, routeShelfMedia, shelfEvents } from "./helpers/shelfFixture";
import { channelPath, openShell } from "./helpers/shellPage";

/**
 * Canvas edit (`~/.buzz/PLANS/CANVAS_EDIT_AGENT_BOX.md`): the file pane reads
 * and writes the share's DISK file through stash's editor API, mocked here at
 * the Files URL with the shapes `app/web/routes/browser.ts` answers (CORS
 * headers included — the browser enforces them on a fulfilled response too).
 *
 * The mock is not stash: it proves what the CLIENT sends (the digest it
 * loaded, the content it typed, the order of save and publish) and what it
 * draws for each answer. stash's own tests prove the server half.
 */

const FILES_URL = "https://crichton.e2e.test/";
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RESULTS_ABS = `${RTS_DIR}/bakeoff-results.md`;
const RESULTS_REL = "MEGA/shared_files/dropbox/rts-bakeoff/bakeoff-results.md";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface StashMock {
  disk: { content: string; mtimeMs: number };
  /** `mode` for the whole Files origin. */
  mode: "ok" | "signed-out" | "unreachable";
  /** GET /file answers 413 (over stash's 2 MiB editor cap). */
  tooLarge: boolean;
  gets: Array<{ rel: string; mtimeMs: string | null; status: number }>;
  puts: Array<{ content: string; digest: string; status: number }>;
  order: string[];
}

async function routeStash(page: Page, initial: string): Promise<StashMock> {
  const mock: StashMock = {
    disk: { content: initial, mtimeMs: 1000 },
    mode: "ok",
    tooLarge: false,
    gets: [],
    puts: [],
    order: [],
  };
  const cors = {
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
  const json = (status: number, body: unknown) => ({
    status,
    contentType: "application/json",
    headers: cors,
    body: JSON.stringify(body),
  });
  await page.route(`${FILES_URL}api/browser/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (mock.mode === "unreachable") {
      await route.abort("failed");
      return;
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "GET, PUT",
          "access-control-allow-headers": "content-type",
        },
      });
      return;
    }
    if (mock.mode === "signed-out") {
      await route.fulfill(json(401, { error: "Unauthorized" }));
      return;
    }
    if (url.pathname === "/api/browser/locate") {
      const abs = url.searchParams.get("abs") ?? "";
      const rel = abs.replace("/Users/sgallant/", "");
      await route.fulfill(
        json(200, { ok: true, root: "home", rel, dir: false }),
      );
      return;
    }
    if (url.pathname === "/api/browser/file" && request.method() === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const known = url.searchParams.get("mtimeMs");
      if (!rel.endsWith(".md")) {
        mock.gets.push({ rel, mtimeMs: known, status: 415 });
        await route.fulfill(
          json(415, { error: "not_editable", kind: "image" }),
        );
        return;
      }
      if (mock.tooLarge) {
        mock.gets.push({ rel, mtimeMs: known, status: 413 });
        await route.fulfill(
          json(413, { error: "too_large", size: 3_000_000, chunked: true }),
        );
        return;
      }
      if (known !== null && Number(known) === mock.disk.mtimeMs) {
        mock.gets.push({ rel, mtimeMs: known, status: 304 });
        await route.fulfill({ status: 304, headers: cors });
        return;
      }
      mock.gets.push({ rel, mtimeMs: known, status: 200 });
      await route.fulfill(
        json(200, {
          ok: true,
          name: "bakeoff-results.md",
          kind: "markdown",
          content: mock.disk.content,
          size: Buffer.byteLength(mock.disk.content),
          mtimeMs: mock.disk.mtimeMs,
          digest: sha256(mock.disk.content),
          lossy: false,
        }),
      );
      return;
    }
    if (url.pathname === "/api/browser/file" && request.method() === "PUT") {
      const body = request.postDataJSON() as {
        content: string;
        digest: string;
        path: string;
      };
      const current = sha256(mock.disk.content);
      if (body.digest !== current) {
        mock.puts.push({
          content: body.content,
          digest: body.digest,
          status: 409,
        });
        await route.fulfill(
          json(409, {
            error: "conflict",
            detail: "file changed on disk",
            size: Buffer.byteLength(mock.disk.content),
            mtimeMs: mock.disk.mtimeMs,
            digest: current,
          }),
        );
        return;
      }
      mock.puts.push({
        content: body.content,
        digest: body.digest,
        status: 200,
      });
      mock.order.push("put");
      mock.disk = { content: body.content, mtimeMs: mock.disk.mtimeMs + 1 };
      await route.fulfill(
        json(200, {
          ok: true,
          name: "bakeoff-results.md",
          size: Buffer.byteLength(body.content),
          mtimeMs: mock.disk.mtimeMs,
          digest: sha256(body.content),
        }),
      );
      return;
    }
    await route.fulfill(json(404, { error: "not_found" }));
  });
  return mock;
}

async function open(
  page: Page,
  options: {
    filesUrl?: string;
    order?: string[];
    path?: Parameters<typeof openShell>[1]["path"];
  } = {},
) {
  let seeded: ReturnType<typeof shelfEvents> | null = null;
  await page.addInitScript((url) => {
    try {
      localStorage.setItem("buzz:files-url.v2", url);
    } catch {
      // The sandboxed preview frame.
    }
  }, options.filesUrl ?? FILES_URL);
  await routeShelfMedia(page);
  const relayOptions: MockRelayOptions = {
    onPublish: (event, relay) => {
      if (event.kind === 9) {
        options.order?.push("publish");
        relay.push(event);
      }
    },
  };
  const opened = await openShell(page, {
    theme: "buzz",
    path: options.path ?? channelPath("flight-path"),
    relay: relayOptions,
    extra: (fixture) => {
      seeded = shelfEvents(fixture);
      return seeded.events;
    },
  });
  if (!seeded) {
    throw new Error("the Shelf fixture was never built");
  }
  return { ...opened, shares: seeded as ReturnType<typeof shelfEvents> };
}

async function openFile(page: Page, title: string) {
  await page
    .getByTestId("channel-sidebar")
    .getByRole("button", { name: /^Shelf/ })
    .click();
  await expect(page.getByTestId("shelf-page")).toBeVisible();
  await page
    .getByTestId("shelf-row")
    .filter({ has: page.getByTestId("shelf-row-title").getByText(title) })
    .click();
  return page.getByTestId("file-preview");
}

const ORIGINAL = "# RTS bake-off: on disk\n\nScores live here.\n";

test.describe("Canvas: edit the shared file on disk", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("edit and save", async ({ page }) => {
    const stash = await routeStash(page, ORIGINAL);
    await open(page);
    const preview = await openFile(page, "bakeoff-results.md");
    await expect(preview.getByTestId("file-version-chip")).toHaveText(
      "Live · crichton",
    );
    // The disk copy, not the shared blob, is on screen.
    await expect(
      preview.getByRole("heading", { name: "RTS bake-off: on disk" }),
    ).toBeVisible();
    await preview.getByTestId("file-edit").click();
    const input = preview.getByTestId("file-editor-input");
    await input.fill("# RTS bake-off: on disk\n\nScores fixed.\n");
    await preview.getByTestId("file-editor-save").click();
    await expect(preview.getByTestId("file-editor-status")).toHaveText("Saved");
    expect(stash.puts).toHaveLength(1);
    expect(stash.puts[0]).toEqual({
      content: "# RTS bake-off: on disk\n\nScores fixed.\n",
      digest: sha256(ORIGINAL),
      status: 200,
    });
    expect(stash.gets[0].rel).toBe(RESULTS_REL);
  });

  test("409 shows three actions, overwrite re-PUTs with server digest", async ({
    page,
  }) => {
    const stash = await routeStash(page, ORIGINAL);
    await open(page);
    const preview = await openFile(page, "bakeoff-results.md");
    await preview.getByTestId("file-edit").click();
    await preview.getByTestId("file-editor-input").fill("Sam's version\n");
    // The agent writes the file after Sam loaded it.
    const agentText = `${ORIGINAL}agent line\n`;
    stash.disk = { content: agentText, mtimeMs: 2000 };
    await preview.getByTestId("file-editor-save").click();
    const conflict = preview.getByTestId("file-editor-conflict");
    await expect(conflict).toBeVisible();
    await expect(conflict.getByTestId("file-conflict-theirs")).toBeVisible();
    await expect(conflict.getByTestId("file-conflict-overwrite")).toBeVisible();
    await expect(conflict.getByTestId("file-conflict-copy")).toBeVisible();
    expect(stash.puts[0].status).toBe(409);
    expect(stash.puts[0].digest).toBe(sha256(ORIGINAL));
    // Nothing was overwritten.
    expect(stash.disk.content).toBe(agentText);
    await conflict.getByTestId("file-conflict-overwrite").click();
    await expect(preview.getByTestId("file-editor-status")).toHaveText("Saved");
    expect(stash.puts[1]).toEqual({
      content: "Sam's version\n",
      digest: sha256(agentText),
      status: 200,
    });
    expect(stash.disk.content).toBe("Sam's version\n");
  });

  test("agent edit appears without action", async ({ page }) => {
    const stash = await routeStash(page, ORIGINAL);
    await open(page);
    const preview = await openFile(page, "bakeoff-results.md");
    await expect(
      preview.getByRole("heading", { name: "RTS bake-off: on disk" }),
    ).toBeVisible();
    // Unchanged: the poll asks with the known mtime and gets 304s.
    await expect
      .poll(() => stash.gets.filter((get) => get.status === 304).length, {
        timeout: 8_000,
      })
      .toBeGreaterThan(0);
    stash.disk = { content: "# Rewritten by the agent\n", mtimeMs: 3000 };
    await expect(
      preview.getByRole("heading", { name: "Rewritten by the agent" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("a dirty draft keeps its text when the agent writes; the banner says so", async ({
    page,
  }) => {
    const stash = await routeStash(page, ORIGINAL);
    await open(page);
    const preview = await openFile(page, "bakeoff-results.md");
    await preview.getByTestId("file-edit").click();
    await preview.getByTestId("file-editor-input").fill("my draft\n");
    stash.disk = { content: "agent text\n", mtimeMs: 4000 };
    await expect(preview.getByTestId("file-editor-changed")).toBeVisible({
      timeout: 6_000,
    });
    await expect(preview.getByTestId("file-editor-input")).toHaveValue(
      "my draft\n",
    );
  });

  test("no Edit for path-less / png / 401 / network error / other host", async ({
    page,
  }) => {
    const stash = await routeStash(page, ORIGINAL);
    await open(page);
    const cases: Array<[string, () => void, string]> = [
      [
        "jitter-buffer-trace.json",
        () => {},
        "Shared as a snapshot with no path on crichton, so it can't be edited here. Ask the agent below.",
      ],
      ["beat-02-capture.png", () => {}, "This file type isn't editable"],
      [
        "project-inventory.md",
        () => {
          stash.mode = "signed-out";
        },
        "Sign in to Files to edit",
      ],
      [
        "design-bakeoff-blind.html",
        () => {
          stash.mode = "unreachable";
        },
        "Files isn't reachable",
      ],
    ];
    for (const [title, arrange, reason] of cases) {
      arrange();
      const preview = await openFile(page, title);
      await expect(preview.getByTestId("file-readonly-reason")).toContainText(
        reason,
      );
      await expect(preview.getByTestId("file-version-chip")).toHaveText(
        "Shared snapshot",
      );
      await expect(preview.getByTestId("file-edit")).toHaveCount(0);
    }
  });

  test("a path on another host than the Files URL is read-only", async ({
    page,
  }) => {
    await routeStash(page, ORIGINAL);
    await open(page, { filesUrl: "https://pilot.e2e.test/" });
    const preview = await openFile(page, "bakeoff-results.md");
    await expect(preview.getByTestId("file-readonly-reason")).toHaveText(
      "This file lives on another computer than the one Files opens, so it can't be edited here.",
    );
    await expect(preview.getByTestId("file-edit")).toHaveCount(0);
  });

  test("a file over the editor cap is read-only, the blob still previews", async ({
    page,
  }) => {
    const stash = await routeStash(page, ORIGINAL);
    stash.tooLarge = true;
    await open(page);
    const preview = await openFile(page, "bakeoff-results.md");
    await expect(preview.getByTestId("file-readonly-reason")).toHaveText(
      "Too large to edit here (over 2 MiB)",
    );
    await expect(preview.getByTestId("file-edit")).toHaveCount(0);
    await expect(
      preview.getByRole("heading", { name: "RTS bake-off: results" }),
    ).toBeVisible();
  });

  test("send to agent", async ({ page }) => {
    await routeStash(page, ORIGINAL);
    const { relay, fixture, shares } = await open(page);
    const preview = await openFile(page, "bakeoff-results.md");
    await expect(preview.getByTestId("agent-box-target")).toContainText(
      "Gilfoyle",
    );
    await expect(preview.getByTestId("file-edited-since-shared")).toBeVisible();
    // "View shared version" swaps the disk copy for the blob, and back.
    await preview.getByTestId("file-view-shared").click();
    await expect(preview.getByTestId("file-version-chip")).toHaveText(
      "Shared snapshot",
    );
    await expect(
      preview.getByRole("heading", { name: "RTS bake-off: results" }),
    ).toBeVisible();
    await preview.getByTestId("file-view-shared").click();
    await expect(preview.getByTestId("file-version-chip")).toHaveText(
      "Live · crichton",
    );
    const box = preview.getByTestId("file-comment-input");
    await box.fill("Fix the dates in the table.");
    await box.press("Enter");
    await expect
      .poll(() =>
        relay.published.find((event) =>
          event.content.startsWith("Fix the dates in the table."),
        ),
      )
      .toBeTruthy();
    const sent = relay.published.find((event) =>
      event.content.startsWith("Fix the dates in the table."),
    ) as MockEvent;
    expect(sent.content).toBe(
      // The disk bytes differ from the shared blob's `x`, so the trailer says so.
      `Fix the dates in the table.\n\n[file: bakeoff-results.md · crichton:${RESULTS_ABS} · edited by you since shared]`,
    );
    // A top-level share is its own thread root: one reply marker.
    expect(sent.tags).toContainEqual(["e", shares.results.id, "", "reply"]);
    expect(sent.tags).toContainEqual(["p", fixture.agents.gilfoyle.pubkey]);
    // The thread under the document never shows the trailer.
    await expect(preview.getByTestId("file-comment")).toHaveCount(2);
    await expect(preview.getByTestId("file-comments")).not.toContainText(
      "[file:",
    );
  });

  test("save-and-send ordering", async ({ page }) => {
    const order: string[] = [];
    const stash = await routeStash(page, ORIGINAL);
    stash.order = order;
    await open(page, { order });
    const preview = await openFile(page, "bakeoff-results.md");
    await preview.getByTestId("file-edit").click();
    await preview.getByTestId("file-editor-input").fill("draft before ask\n");
    const box = preview.getByTestId("file-comment-input");
    await box.fill("Tidy the rest.");
    await box.press("Enter");
    await preview.getByTestId("agent-box-save-and-send").click();
    await expect.poll(() => order.length).toBe(2);
    expect(order).toEqual(["put", "publish"]);
    expect(stash.disk.content).toBe("draft before ask\n");
  });
});

test.describe("Canvas edit on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("390: the edit strip is usable (44 px targets) and saves", async ({
    page,
  }) => {
    const stash = await routeStash(page, ORIGINAL);
    await open(page, { path: () => "/repos?view=work" });
    await page
      .getByTestId("phone-tab-bar")
      .getByRole("button", { name: "More" })
      .click();
    await page
      .getByTestId("phone-more-sheet")
      .getByRole("button", { name: "Shelf" })
      .click();
    await page
      .getByTestId("shelf-row")
      .filter({
        has: page
          .getByTestId("shelf-row-title")
          .getByText("bakeoff-results.md"),
      })
      .click();
    const sheet = page.getByTestId("file-preview-sheet");
    await expect(sheet.getByTestId("file-version-chip")).toHaveText(
      "Live · crichton",
    );
    await sheet.getByTestId("file-edit").click();
    for (const id of ["file-editor-save", "file-editor-cancel"]) {
      const box = await sheet.getByTestId(id).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await sheet.getByTestId("file-editor-input").fill("phone edit\n");
    await sheet.getByTestId("file-editor-save").click();
    await expect(sheet.getByTestId("file-editor-status")).toHaveText("Saved");
    expect(stash.disk.content).toBe("phone edit\n");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
