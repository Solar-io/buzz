import { expect, type Page, test } from "@playwright/test";

import {
  HATCH,
  type HatchMock,
  installHatchMock,
  type MeMode,
  terminalText,
} from "./helpers/hatchMock";
import { installMockRelay } from "./helpers/mockRelay";
import { channelPath, openShell, shot } from "./helpers/shellPage";
import { signIn } from "./helpers/signIn";
import { buildWorkFixture, routeUsageHub } from "./helpers/workFixture";

/**
 * Terminal (web redesign Phase 7; Terminal / PhoneTerminal / Vitals
 * artboards), end to end against a mocked hatch: the real page, the real
 * vendored xterm 5.5 bundle and the real `/ws/term` client, with hatch faked
 * at the HTTP and WebSocket boundary (helpers/hatchMock.ts).
 *
 * Service workers are blocked: sw.js caches /assets/* cache-first, and a
 * cached vendor bundle would mask exactly the load failures W-6 provokes.
 *
 * `SHOTS_DIR=… pnpm exec playwright test --project=smoke terminal` also
 * writes the artboard screenshots at 1440 and 390, both themes.
 */

test.use({ serviceWorkers: "block" });

const terminalPath = () => "/repos?view=terminal";

async function openTerminal(
  page: Page,
  theme: string,
  options: { me?: MeMode; viaSidebar?: boolean } = {},
): Promise<HatchMock> {
  const hatch = await installHatchMock(page, { me: options.me });
  // openShell's steps, with hatch's socket route registered after the relay
  // mock's catch-all and before sign-in (the page connects straight away).
  const fixture = buildWorkFixture();
  await page.addInitScript((value) => {
    localStorage.setItem("buzz-theme", value);
    localStorage.setItem("buzz-follow-system", "false");
  }, theme);
  await routeUsageHub(page);
  await installMockRelay(page, fixture.events);
  await hatch.routeSocket();
  await signIn(
    page,
    options.viaSidebar ? channelPath()(fixture) : terminalPath(),
    fixture.viewerKey,
  );
  if (options.viaSidebar) {
    await page
      .getByTestId("app-shell-sidebar")
      .getByRole("button", { name: "Terminal", exact: true })
      .click();
  }
  await expect(page.getByTestId("terminal-page")).toBeVisible();
  return hatch;
}

async function waitConnected(page: Page) {
  await expect(
    page
      .getByTestId("terminal-pill")
      .or(page.getByTestId("terminal-dot"))
      .first(),
  ).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`desktop 1440 · ${theme} · Terminal`, () => {
    test.use({ viewport: { width: 1440, height: 960 } });

    test("open from the sidebar, run a command, reset view, and the session survives", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const hatch = await openTerminal(page, theme, { viaSidebar: true });
      await waitConnected(page);

      // Desktop shows herdr itself, no mirrored chrome (Sam 10/1): herdr
      // draws its own spaces and tabs, so no rail and no tab strip.
      await expect
        .poll(() => terminalText(page))
        .toContain("redesign the vitals block");
      await expect(page.getByTestId("terminal-rail")).toHaveCount(0);
      await expect(page.getByTestId("terminal-tabs")).toHaveCount(0);

      // The sidebar row is selected; the Vitals block grew crichton's rows.
      await expect(
        page
          .getByTestId("app-shell-sidebar")
          .getByRole("button", { name: "Terminal", exact: true }),
      ).toHaveAttribute("data-active", "true");
      await expect(page.getByTestId("vitals-row-cpu")).toContainText("38%");
      await expect(page.getByTestId("vitals-row-gpu")).toContainText("71%");
      await expect(page.getByTestId("vitals-row-mem")).toContainText("64%");
      await expect(page.getByTestId("vitals-row-disk")).toContainText("62%");
      await expect(page.getByTestId("crichton-status")).toHaveAttribute(
        "data-status",
        "ok",
      );

      // The transcript the session already had is on screen.
      await expect
        .poll(() => terminalText(page))
        .toContain("redesign the vitals block");
      await shot(page, `terminal-${theme}-1440`);

      // Run a command.
      await page.getByTestId("terminal-screen").click();
      await page.keyboard.type("echo ok");
      await page.keyboard.press("Enter");
      await expect
        .poll(async () =>
          (await terminalText(page)).split("\n").map((l) => l.trim()),
        )
        .toContain("ok");

      // Reset view: a `reset` control frame, close 4002, and a reconnect with
      // the SAME id — nothing killed, the shell's screen comes back.
      const firstId = hatch.connections[0]?.id;
      expect(firstId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      await page.getByTestId("terminal-reset").click();
      await expect.poll(() => hatch.connections.length).toBe(2);
      expect(hatch.controls.some((frame) => frame.type === "reset")).toBe(true);
      expect(hatch.connections[1]?.id).toBe(firstId);
      await waitConnected(page);
      await expect
        .poll(async () =>
          (await terminalText(page)).split("\n").map((l) => l.trim()),
        )
        .toContain("ok");
      expect(errors).toEqual([]);
    });

    test("the Vitals popover carries crichton: uptime, sparklines, every disk, services", async ({
      page,
    }) => {
      await openTerminal(page, theme);
      await waitConnected(page);
      await page.getByTestId("vitals-block").click();
      const panel = page.getByTestId("vitals-crichton-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("up 12d 4h");
      await expect(panel).toContainText("load 5.2 · 3.9 · 3.4");
      await expect(panel).toContainText("41.2 / 64 GB · pressure normal");
      await expect(panel).toContainText("Data · 740 GB free");
      await expect(panel).toContainText("crichton-backups · 320 GB free");
      await expect(panel).toContainText(
        "6 Buzz services up · tts bridge restarted 2h ago",
      );
      await shot(page, `vitals-crichton-${theme}`);
    });
  });

  test.describe(`phone 390 · ${theme} · Terminal`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("the key bar replaces the tab bar and sends exact bytes", async ({
      page,
    }) => {
      const hatch = await openTerminal(page, theme);
      await waitConnected(page);
      await expect(page.getByTestId("terminal-keybar")).toBeVisible();
      // The terminal owns the screen: no tab bar, no shell top bar.
      await expect(page.getByTestId("phone-tab-bar")).toHaveCount(0);
      await expect(page.getByTestId("app-shell-phone-bar")).toBeHidden();
      await expect(page.getByTestId("terminal-tab")).toHaveCount(3);
      await expect
        .poll(() => terminalText(page))
        .toContain("redesign the vitals block");
      await shot(page, `terminal-phone-${theme}-390`);

      const sent = () => hatch.inputs.map((b) => b.toString("latin1"));
      await page.getByTestId("key-esc").dispatchEvent("pointerdown");
      await page.getByTestId("key-tab").dispatchEvent("pointerdown");
      await page.getByTestId("key-up").dispatchEvent("pointerdown");
      await page.getByTestId("key-up").dispatchEvent("pointerup");
      await expect.poll(sent).toEqual(["\x1b", "\t", "\x1b[A"]);

      // ctrl latches: the bar shows it pressed, the NEXT key carries it.
      await page.getByTestId("key-ctrl").dispatchEvent("pointerdown");
      await expect(page.getByTestId("key-ctrl")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByTestId("key-left").dispatchEvent("pointerdown");
      await page.getByTestId("key-left").dispatchEvent("pointerup");
      await expect.poll(sent).toEqual(["\x1b", "\t", "\x1b[A", "\x1b[1;5D"]);
      await expect(page.getByTestId("key-ctrl")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });
}

test.describe("states · desktop 1440", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("kill switch off: a disabled card, and no socket at all", async ({
    page,
  }) => {
    const hatch = await openTerminal(page, "buzz", { me: "disabled" });
    const status = page.getByTestId("terminal-status");
    await expect(status).toHaveAttribute("data-state", "disabled");
    await expect(status).toContainText("The terminal is off");
    await expect(status).toContainText("kill switch");
    expect(hatch.connections).toHaveLength(0);
    await shot(page, "terminal-disabled-buzz-1440");
  });

  test("kill switch flipped while connected: close 4004 shows disabled within 3 s", async ({
    page,
  }) => {
    const hatch = await openTerminal(page, "buzz-dark");
    await waitConnected(page);
    hatch.setMe("disabled");
    hatch.closeAll(4004, "terminal disabled");
    await expect(page.getByTestId("terminal-status")).toHaveAttribute(
      "data-state",
      "disabled",
      {
        timeout: 3_000,
      },
    );
    // No reconnect storm against a switched-off terminal.
    await page.waitForTimeout(1_500);
    expect(hatch.connections).toHaveLength(1);
  });

  test("signed out: sign in opens hatch's GitHub flow, and its message brings the shell", async ({
    page,
  }) => {
    const hatch = await openTerminal(page, "buzz", { me: "signed-out" });
    const status = page.getByTestId("terminal-status");
    await expect(status).toContainText("Sign in to crichton");
    // Vitals says sign in, not 0% — in the popover. The block itself has no
    // crichton numbers to show, so it has no crichton section (Sam,
    // 2026-10-01: never a header standing over nothing). The popover is
    // checked FIRST: it proves the poll has answered, so the block's
    // missing section is a decision and not a poll still in flight.
    await page.getByTestId("vitals-block").click();
    const panel = page.getByTestId("vitals-crichton-panel");
    await expect(panel.getByTestId("crichton-status")).toHaveAttribute(
      "data-status",
      "signed-out",
    );
    await expect(panel).toContainText(
      "Sign in to crichton from the Terminal page",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("vitals-crichton-panel")).toHaveCount(0);
    await expect(page.getByTestId("vitals-crichton")).toHaveCount(0);
    await shot(page, "terminal-signed-out-buzz-1440");
    // hatch's /auth/github, faked to land straight on /auth/signed-in's job:
    // tell the opener, at the page's origin.
    const origin = new URL(page.url()).origin;
    await page.context().route(`${HATCH}auth/github**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>window.opener.postMessage({type:"hatch:signed-in"}, ${JSON.stringify(origin)});</script>`,
      }),
    );
    hatch.setMe("ok");
    const popupPromise = page.waitForEvent("popup");
    await status.getByRole("button", { name: "Sign in with GitHub" }).click();
    const popup = await popupPromise;
    expect(popup.url()).toBe(
      `${HATCH}auth/github?redirectTo=%2Fauth%2Fsigned-in`,
    );
    await waitConnected(page);
    expect(hatch.connections).toHaveLength(1);
  });

  test("not allowed: a 403 names the account problem, not the network", async ({
    page,
  }) => {
    await openTerminal(page, "buzz", { me: "forbidden" });
    await expect(page.getByTestId("terminal-status")).toContainText(
      "This account can't open crichton",
    );
  });

  test("W-6: the WebGL bundle 404s → the canvas renderer, and the terminal still boots", async ({
    page,
  }) => {
    await page.route("**/assets/vendor/xterm-5.5.0/addon-webgl.js", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    await openTerminal(page, "buzz");
    await waitConnected(page);
    await expect(page.getByTestId("terminal-mount")).toHaveAttribute(
      "data-renderer",
      "canvas",
    );
    await expect
      .poll(() => terminalText(page))
      .toContain("redesign the vitals block");
  });

  test("W-6: both GPU bundles 404 → the DOM renderer, still a working terminal", async ({
    page,
  }) => {
    await page.route(
      /\/assets\/vendor\/xterm-5\.5\.0\/addon-(webgl|canvas)\.js$/,
      (route) => route.fulfill({ status: 404, body: "" }),
    );
    await openTerminal(page, "buzz");
    await waitConnected(page);
    await expect(page.getByTestId("terminal-mount")).toHaveAttribute(
      "data-renderer",
      "dom",
    );
    await expect
      .poll(() => terminalText(page))
      .toContain("redesign the vitals block");
  });

  test("W-4: no hatch URL → no Terminal row and no crichton rows", async ({
    page,
  }) => {
    await openShell(page, { theme: "buzz", path: channelPath() });
    await expect(page.getByTestId("vitals-block")).toBeVisible();
    await expect(
      page
        .getByTestId("app-shell-sidebar")
        .getByRole("button", { name: "Terminal", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("vitals-crichton")).toHaveCount(0);
  });
});
