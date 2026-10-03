import { expect, type Page, test } from "@playwright/test";

import { hexId, type MockEvent, mockEvent } from "./helpers/mockRelay";
import {
  channelPath as shellChannelPath,
  openShell,
  shot,
} from "./helpers/shellPage";
import {
  buildTaskStatus,
  BLADE_DONE_LINE,
  CRASH_PICKUP_LINE,
  detailHead,
  lifecycleHead,
  jobHead,
  PR_TITLE,
} from "./helpers/taskStatusFixture";
import type { WorkFixture } from "./helpers/workFixture";

/**
 * Work tab v2 (web redesign Phase 8), driven through the real sign-in against
 * a relay faked at the WebSocket boundary.
 *
 * What only this can prove: the 30624 REQ is actually opened (with `#h`, or
 * the mock's live push would never reach it), the heads it returns reach the
 * Running and Done rows through the provider, a live update lands on the SAME
 * row, and a terminal head moves the turn from Running to Done. The unit
 * suites prove the join; this proves the join is wired.
 *
 * `SHOTS_DIR=… pnpm exec playwright test --project=smoke work-status` writes
 * the Main / PhoneWork / PhoneChannel comparison shots, both themes.
 */

const channelPath = shellChannelPath();
const now = () => Math.floor(Date.now() / 1000);

async function open(
  page: Page,
  theme: string,
  path: (fixture: WorkFixture) => string,
) {
  let built: ReturnType<typeof buildTaskStatus> | null = null;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const { fixture, relay } = await openShell(page, {
    theme,
    path,
    extra: (base) => {
      built = buildTaskStatus(base);
      return built.events;
    },
  });
  if (!built) {
    throw new Error("the status fixture was not built");
  }
  const status = built as ReturnType<typeof buildTaskStatus>;
  const card = status.events.find(
    (event: MockEvent) =>
      event.kind === 9 && event.tags.some((tag) => tag[0] === "card"),
  ) as MockEvent;
  return { fixture, relay, status, card, pageErrors };
}

const rowKey = (agent: string, turn: string) =>
  `[data-row-key="turn:${agent}:${turn}"]`;

test("a queued Yes fetches its reply parent, while a long ask keeps its text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const { fixture, relay, pageErrors } = await open(page, "buzz", channelPath);
  const parentId = "6a".repeat(32);
  const triggerId = "6b".repeat(32);
  const longId = "6c".repeat(32);
  const c = fixture.channels.ops;
  const agent = fixture.agents.cereal.pubkey;
  relay.add(
    mockEvent({
      id: parentId,
      kind: 9,
      pubkey: fixture.viewer,
      tags: [["h", c]],
      content: "🙋 **Question:** Audit the release signing settings?",
    }),
    mockEvent({
      id: triggerId,
      kind: 9,
      pubkey: fixture.viewer,
      tags: [
        ["h", c],
        ["e", parentId, "", "reply"],
      ],
      content: "**Yes**",
    }),
    mockEvent({
      id: longId,
      kind: 9,
      pubkey: fixture.viewer,
      tags: [
        ["h", c],
        ["e", parentId, "", "reply"],
      ],
      content: "Publish the TestFlight build link here",
    }),
  );
  relay.push(
    mockEvent({
      id: "6d".repeat(32),
      kind: 7,
      pubkey: agent,
      tags: [
        ["h", c],
        ["e", triggerId],
      ],
      content: "👀",
    }),
    mockEvent({
      id: "6e".repeat(32),
      kind: 7,
      pubkey: agent,
      tags: [
        ["h", c],
        ["e", longId],
      ],
      content: "👀",
    }),
  );
  const rail = page.getByTestId("work-rail");
  await rail.getByRole("button", { name: /Queued\s*4/ }).click();
  await expect(
    rail
      .getByRole("region", { name: "Queued" })
      .getByTestId("work-row-ask")
      .filter({ hasText: "Audit the release signing settings?" }),
  ).toHaveText("Sam: Audit the release signing settings?", { timeout: 10_000 });
  await expect(
    rail
      .getByRole("region", { name: "Queued" })
      .getByTestId("work-row-ask")
      .filter({ hasText: "Publish the TestFlight build link here" }),
  ).toHaveText("Sam: Publish the TestFlight build link here");
  expect(pageErrors).toEqual([]);
});

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`desktop 1440 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 960 } });

    test("background jobs get their own Running rows, coexist, and finish into Done", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const at = now();
      const { fixture, relay } = await openShell(page, {
        theme,
        path: shellChannelPath("ops"),
        extra: (base) => {
          const agent = base.agents.cereal.pubkey;
          const ch = base.channels.ops;
          return [
            lifecycleHead(agent, ch, "launcher", "done", at - 20, at - 2400),
            jobHead(agent, ch, "coder-1", "running", at - 30, at - 2280, {
              role: "coder",
              model: "gpt-6.1-sol",
              title: "Fix stash restore",
            }),
            jobHead(agent, ch, "tester-1", "running", at - 30, at - 1800, {
              role: "tester",
              model: "gpt-6.1-sol",
              title: "Exercise rebase",
            }),
            jobHead(agent, ch, "dropped-1", "running", at - 400, at - 2500, {
              role: "coder",
              model: "gpt-6.1-sol",
              title: "Old worker",
            }),
          ];
        },
      });
      await expect(page.locator("html")).toHaveClass(
        theme === "buzz-dark" ? /\bdark\b/ : /\blight\b/,
      );
      const rail = page.getByTestId("work-rail");
      const running = rail.getByRole("region", { name: "Running" });
      const key = (id: string) =>
        `[data-row-key="job:${fixture.agents.cereal.pubkey}:${fixture.channels.ops}:${id}"]`;
      await expect(running.getByTestId("run-row-job")).toHaveCount(2);
      const coder = running.locator(key("coder-1"));
      const tester = running.locator(key("tester-1"));
      await expect(coder).toContainText("Cereal Killer → GPT coder · #ops");
      await expect(coder).toContainText("Fix stash restore");
      await expect(coder).toContainText("38m");
      await expect(tester).toContainText("→ GPT tester");
      await expect(tester).toContainText("Exercise rebase");
      await expect(coder.getByTestId("progress-segments")).toHaveCount(0);
      await expect(coder.getByRole("button", { name: /Dismiss/ })).toHaveCount(
        0,
      );
      await expect(running.locator(key("dropped-1"))).toHaveCount(0);
      await rail.getByRole("button", { name: /Done today/ }).click();
      const done = rail.getByRole("region", { name: "Done today" });
      await expect(done.locator(key("dropped-1"))).toContainText(
        "dropped · no heartbeat",
      );
      await expect(page.getByTestId("running-strip-line")).toContainText(
        "→ GPT coder",
      );
      await expect(page.getByTestId("running-strip-line")).toContainText(
        "→ GPT tester",
      );
      await shot(page, `jobs-running-${theme}-1440`);
      relay.push(
        jobHead(
          fixture.agents.cereal.pubkey,
          fixture.channels.ops,
          "coder-1",
          "done",
          now() + 1,
          at - 2280,
          { role: "coder", model: "gpt-6.1-sol", title: "Fix stash restore" },
        ),
      );
      await expect(coder).toHaveCount(0);
      await expect(running.getByTestId("run-row-job")).toHaveCount(1);
      const finished = done.locator(key("coder-1"));
      await expect(finished).toContainText("→ GPT coder");
      await expect(finished).toContainText("Fix stash restore");
      await expect(finished).not.toContainText("error");
      await finished.scrollIntoViewIfNeeded();
      await shot(page, `jobs-done-${theme}-1440`);
      expect(pageErrors).toEqual([]);
    });

    test("Running rows carry 30624 titles and progress; a turn moves to Done in place", async ({
      page,
    }) => {
      const { fixture, relay, status, card, pageErrors } = await open(
        page,
        theme,
        channelPath,
      );
      const a = fixture.agents;
      const rail = page.getByTestId("work-rail");
      const running = rail.getByRole("region", { name: "Running" });

      // Five working (four of the viewer's own turns + another member's
      // agent seen only through 30624), two silent ones still listed.
      await expect(running.getByTestId("run-row-live")).toHaveCount(5);
      await expect(running.getByTestId("run-row-stalled")).toHaveCount(2);

      // Observer + status for the same turn: ONE row, titled, 1/3.
      const nikon = running.locator(rowKey(a.nikon.pubkey, "t-nikon"));
      await expect(nikon).toHaveCount(1);
      // Two lines: "Name  #channel" over the title (run-row-title).
      await expect(nikon).toContainText("#flight-path");
      await expect(nikon.getByTestId("run-row-title")).toHaveText(
        "Capture pass",
      );
      await expect(nikon.getByTestId("progress-segments")).toHaveAttribute(
        "data-progress",
        "1/3",
      );
      // Past five steps: words, not segments.
      const acid = running.locator(rowKey(a.acid.pubkey, "t-acid"));
      await expect(acid).toContainText("4 of 7 · #engineering");
      await expect(acid.getByTestId("run-row-title")).toHaveText(
        "Jitter buffer QA",
      );
      await expect(acid.getByTestId("progress-segments")).toHaveCount(0);
      // A detail stamped with an EARLIER turn never titles this one (D8.3).
      const crash = running.locator(rowKey(a.crash.pubkey, "t-crash"));
      await expect(crash).toBeVisible();
      await expect(crash).not.toContainText("Stale title");
      // No title: its own in-turn pickup says what it is working on.
      await expect(crash.getByTestId("run-row-title")).toHaveCount(0);
      await expect(crash.getByTestId("work-row-ask")).toHaveText(
        CRASH_PICKUP_LINE,
      );
      // A row with a second line grows; one without stays 34 px.
      const crashBox = await crash.boundingBox();
      expect(crashBox?.height ?? 0).toBeGreaterThanOrEqual(43);
      const jaredBox = await running
        .locator(rowKey(a.jared.pubkey, "t-jared"))
        .boundingBox();
      expect(Math.round(jaredBox?.height ?? 0)).toBeLessThanOrEqual(35);
      // No 30624 at all (a heartbeat turn): the observer row stands alone.
      await expect(
        running.locator(rowKey(a.jared.pubkey, "t-jared")),
      ).toContainText("heartbeat");
      // Another member's agent, readable only through 30624.
      const razor = running.locator(
        rowKey(status.agents.razor.pubkey, "r-run"),
      );
      await expect(razor).toContainText("#ops");
      await expect(razor.getByTestId("run-row-title")).toHaveText(
        "Restore drill",
      );
      await expect(razor.getByTestId("progress-segments")).toHaveAttribute(
        "data-progress",
        "2/3",
      );
      // A head that stopped refreshing is said out loud, never hidden.
      const blade = running.locator(
        rowKey(status.agents.blade.pubkey, "b-run"),
      );
      await expect(blade).toHaveAttribute("data-testid", "run-row-stalled");
      await expect(blade).toContainText("no heartbeat");

      // The PR-merge ask is an APPROVAL, beside the two workflow gates.
      const pr = rail.getByTestId(`need-row-ask:${card.id}`);
      await expect(pr).toContainText(PR_TITLE);
      await expect(pr).toContainText("APPROVAL · PR · buzz · #engineering");
      await expect(
        rail.getByRole("button", { name: /^Approvals 3$/ }),
      ).toBeVisible();
      await expect(rail.getByRole("button", { name: /^All 9$/ })).toBeVisible();

      // Done today folds to its newest titled turn (Main artboard).
      const done = rail.getByRole("button", { name: /Done today\s*5/ });
      await expect(done).toContainText("last: Merge-queue sweep");

      // The composer line names what the one working agent is doing.
      const strip = page.getByTestId("running-strip-line");
      await expect(strip).toContainText("Lord Nikon · Capture pass");
      await expect(strip.getByTestId("progress-segments")).toHaveAttribute(
        "data-progress",
        "1/3",
      );
      // It sits directly ABOVE the box (Sam, 2026-09-30), not under it.
      // (The channel's own box: open threads carry reply boxes of their own.)
      const stripBox = await strip.boundingBox();
      const inputBox = await strip
        .locator("xpath=..")
        .getByTestId("composer-input")
        .boundingBox();
      const stripBottom = (stripBox?.y ?? 0) + (stripBox?.height ?? 0);
      expect(stripBox).not.toBeNull();
      expect(inputBox).not.toBeNull();
      expect(stripBottom).toBeLessThanOrEqual(inputBox?.y ?? 0);
      expect((inputBox?.y ?? 0) - stripBottom).toBeLessThan(24);
      // Typing rides the same slot; the timeline's own row is gone. An agent
      // the strip already names as working is not repeated as typing (its
      // harness types for the whole turn); anyone else is said — Gilfoyle
      // (a voice in this channel, running only in #design) stands in for a
      // person, since names resolve from the conversation's own profiles.
      const flightId = fixture.channels["flight-path"];
      const typingFrame = (seed: number, pubkey: string) =>
        mockEvent({
          id: hexId(seed, "7"),
          kind: 20002,
          pubkey,
          tags: [["h", flightId]],
        });
      relay.push(
        typingFrame(1, a.nikon.pubkey),
        typingFrame(2, a.gilfoyle.pubkey),
      );
      const typingLine = page.getByTestId("typing-line");
      await expect(typingLine).toHaveText("Gilfoyle is typing");
      await expect(page.getByText(/Lord Nikon is typing/)).toHaveCount(0);
      const typingBox = await typingLine.boundingBox();
      const inputNow = await strip
        .locator("xpath=..")
        .getByTestId("composer-input")
        .boundingBox();
      expect(typingBox).not.toBeNull();
      expect(
        (typingBox?.y ?? 0) + (typingBox?.height ?? 0),
      ).toBeLessThanOrEqual(inputNow?.y ?? 0);
      expect(pageErrors).toEqual([]);
      await shot(page, `status-main-${theme}-1440`);

      // LIVE: `buzz status set --progress 2/3` lands on the same row.
      const flight = fixture.channels["flight-path"];
      relay.push(
        detailHead(a.nikon.pubkey, flight, "t-nikon", now() + 21, {
          progress: [2, 3],
        }),
      );
      await expect(nikon.getByTestId("progress-segments")).toHaveAttribute(
        "data-progress",
        "2/3",
      );
      await expect(nikon).toContainText("Capture pass", {
        timeout: 1_000,
      });
      // A lifecycle refresh is the heartbeat, not a second row.
      relay.push(
        lifecycleHead(
          a.nikon.pubkey,
          flight,
          "t-nikon",
          "running",
          now() + 22,
          now() - 100,
        ),
      );
      await page.waitForTimeout(1_200);
      await expect(nikon).toHaveCount(1);
      await expect(running.getByTestId("run-row-live")).toHaveCount(5);

      // LIVE: the harness says the turn ended — Running → Done.
      relay.push(
        lifecycleHead(
          a.nikon.pubkey,
          flight,
          "t-nikon",
          "done",
          now() + 23,
          now() - 100,
        ),
      );
      await expect(nikon).toHaveCount(0);
      await expect(running.getByTestId("run-row-live")).toHaveCount(4);
      await expect(
        rail.getByRole("button", { name: /Done today\s*6/ }),
      ).toContainText("last: Capture pass");
      await expect(strip).toHaveCount(0);

      // Expanded: one row per turn, titled where the agent said, abnormal
      // endings said; the turn both sources report is listed once.
      await rail.getByRole("button", { name: /Done today\s*6/ }).click();
      const rows = rail
        .getByRole("region", { name: "Done today" })
        .getByTestId("done-row");
      await expect(rows).toHaveCount(6);
      await expect(rows.first()).toContainText("#flight-path");
      await expect(rows.first().getByTestId("work-row-ask")).toHaveText(
        "Capture pass",
      );
      await expect(rows.filter({ hasText: "Beat 01 captured" })).toHaveCount(1);
      await expect(
        rows.filter({ hasText: "error · harness-restart" }),
      ).toHaveCount(1);
      await expect(
        rows
          .filter({ hasText: "error · harness-restart" })
          .getByTestId("work-row-ask"),
      ).toHaveText(BLADE_DONE_LINE);
      await expect(
        rows.filter({ hasText: "Next turn: unrelated work" }),
      ).toHaveCount(0);
      // The rail now overflows: it scrolls, and the folded Queued row keeps
      // its 34 px instead of being squeezed by the flex column.
      const queued = await rail
        .getByRole("button", { name: /Queued\s*2/ })
        .boundingBox();
      expect(queued?.height ?? 0).toBeGreaterThanOrEqual(33);
      await shot(page, `status-done-${theme}-1440`);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe(`phone 390 · ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the Work page lists titled turns; the channel bar names the work", async ({
      page,
    }) => {
      const { fixture, relay, pageErrors } = await open(
        page,
        theme,
        () => "/repos",
      );
      // The phone opens on Channels (Sam, 2026-10-01; was Work): Work is
      // the tab bar's middle tab.
      await page
        .getByTestId("phone-tab-bar")
        .getByRole("button", { name: /Work/ })
        .click();
      const work = page.getByTestId("work-page");
      await expect(work).toBeVisible();
      await expect(
        work.getByRole("button", { name: /^Needs you 9$/ }),
      ).toBeVisible();
      await shot(page, `status-phone-needs-${theme}-390`);

      await work.getByRole("button", { name: /^Running 7$/ }).click();
      const titles = work.getByTestId("run-row-title");
      await expect(titles.filter({ hasText: "Capture pass" })).toBeVisible();
      await expect(
        titles.filter({ hasText: "Jitter buffer QA · 4 of 7" }),
      ).toBeVisible();
      await expect(titles.filter({ hasText: "Restore drill" })).toBeVisible();
      // Untitled: the phone row carries the agent's own pickup line too.
      await expect(
        work
          .locator(rowKey(fixture.agents.crash.pubkey, "t-crash"))
          .getByTestId("work-row-ask"),
      ).toHaveText(CRASH_PICKUP_LINE);
      await expect(work.getByText(/no heartbeat/).first()).toBeVisible();
      // Nothing scrolls sideways at phone width.
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await shot(page, `status-phone-running-${theme}-390`);

      // Tapping the row opens its channel, where the bar says what it is.
      await work
        .locator(rowKey(fixture.agents.nikon.pubkey, "t-nikon"))
        .getByRole("button")
        .first()
        .click();
      const bar = page.getByTestId("running-strip-bar");
      await expect(bar).toContainText("Lord Nikon · Capture pass");
      await expect(bar.getByTestId("progress-segments")).toHaveAttribute(
        "data-progress",
        "1/3",
      );
      // The working line above the box stays a desktop line (the bar says
      // it here), but someone typing is said above the box at phone width
      // too — a phone has no other place that says so.
      await expect(page.getByTestId("running-strip-line")).toBeHidden();
      relay.push(
        mockEvent({
          id: hexId(3, "7"),
          kind: 20002,
          pubkey: fixture.agents.gilfoyle.pubkey,
          tags: [["h", fixture.channels["flight-path"]]],
        }),
      );
      await expect(page.getByTestId("typing-line")).toBeVisible();
      await expect(page.getByTestId("typing-line")).toHaveText(
        "Gilfoyle is typing",
      );
      await shot(page, `status-phone-channel-${theme}-390`);
      expect(pageErrors).toEqual([]);
    });
  });
}
