import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { mockEvent } from "./helpers/mockRelay";
import { openShell, channelPath, shot } from "./helpers/shellPage";
import {
  buildTaskStatus,
  CRASH_ASK_ID,
  CRASH_PICKUP_LINE,
  lifecycleHead,
} from "./helpers/taskStatusFixture";

// Independent QA regressions for 63eeb8a14. Retain uncommitted for the coder.
const now = () => Math.floor(Date.now() / 1000);

async function saveFrames(name: string, data: unknown) {
  const file = test.info().outputPath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
  await test
    .info()
    .attach(name, { path: file, contentType: "application/json" });
}

test("QA: Running Yes resolves the agent pickup and its reply parent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const { fixture, relay } = await openShell(page, {
    theme: "buzz",
    path: channelPath(),
    extra: (base) => {
      const built = buildTaskStatus(base);
      const trigger = built.events.find((e) => e.id === CRASH_ASK_ID);
      if (!trigger) throw new Error("Missing Crash trigger fixture");
      trigger.content = "Yes";
      trigger.tags.push(["e", "8a".repeat(32), "", "reply"]);
      return [
        ...built.events,
        mockEvent({
          id: "8a".repeat(32),
          kind: 9,
          pubkey: base.viewer,
          tags: [["h", base.channels.mobile]],
          content: "Audit the release signing settings?",
        }),
      ];
    },
  });
  const rail = page.getByTestId("work-rail");
  const crash = rail.locator('[data-row-key$=":t-crash"]');
  await expect(crash.getByTestId("work-row-ask")).toHaveText(
    CRASH_PICKUP_LINE,
    { timeout: 10_000 },
  );
  await shot(page, "qa-running-yes-pickup");

  // A status-only turn with no own message proves the separate parent path.
  relay.push(
    lifecycleHead(
      fixture.agents.cereal.pubkey,
      fixture.channels.mobile,
      "qa-parent",
      "running",
      now(),
      now() - 10,
      undefined,
      CRASH_ASK_ID,
    ),
  );
  const parent = rail.locator('[data-row-key$=":qa-parent"]');
  await expect(parent.getByTestId("work-row-ask")).toHaveText(
    "Sam: Audit the release signing settings?",
    { timeout: 10_000 },
  );
  await shot(page, "qa-running-yes-parent");
});

test("QA: stable Work feed does not storm history requests over two minutes", async ({
  page,
}) => {
  test.setTimeout(155_000);
  const frames: { at: number; frame: unknown[] }[] = [];
  await page.setViewportSize({ width: 1440, height: 960 });
  await openShell(page, {
    theme: "buzz",
    path: channelPath(),
    relay: { onFrame: (frame) => frames.push({ at: Date.now(), frame }) },
    extra: (base) => buildTaskStatus(base).events,
  });
  await expect(page.getByTestId("work-rail")).toBeVisible();
  await page.waitForTimeout(5_000);
  // Multiple provider debounces can put the first activity REQ just after
  // the shell mounts. Start the census only once that real request exists.
  await expect
    .poll(
      () =>
        frames.filter(
          (r) =>
            r.frame[0] === "REQ" &&
            r.frame.slice(2).some((f) => {
              const filter = f as Record<string, unknown>;
              return (
                Array.isArray(filter.kinds) &&
                filter.kinds.includes(9) &&
                filter.limit === 5
              );
            }),
        ).length,
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  const started = Date.now();
  await page.waitForTimeout(120_000);
  await saveFrames("two-minute-request-census.json", {
    started,
    ended: Date.now(),
    frames,
  });
  const activity = frames.filter(
    (r) =>
      r.frame[0] === "REQ" &&
      r.frame.slice(2).some((f) => {
        const filter = f as Record<string, unknown>;
        return (
          Array.isArray(filter.kinds) &&
          filter.kinds.includes(9) &&
          filter.limit === 5
        );
      }),
  );
  expect(activity.length).toBeGreaterThan(0);
  const initial = activity.filter((r: { at: number }) => r.at < started);
  const later = activity.filter((r: { at: number }) => r.at >= started);
  const pairs = new Set(
    initial.map((r: { frame: unknown[] }) => {
      const f = r.frame[2] as { authors: string[]; "#h": string[] };
      return `${f.authors[0]}|${f["#h"][0]}`;
    }),
  );
  expect(pairs.size).toBeGreaterThan(0);
  expect(later.length).toBeLessThanOrEqual(pairs.size * 3);
  for (const request of activity) {
    expect(
      frames.some(
        (r: { frame: unknown[] }) =>
          r.frame[0] === "CLOSE" && r.frame[1] === request.frame[1],
      ),
    ).toBe(true);
  }
});

test("QA: Done accepts final words arriving after its history EOSE within grace", async ({
  page,
}) => {
  const frames: { at: number; frame: unknown[] }[] = [];
  await page.setViewportSize({ width: 1440, height: 960 });
  const { fixture, relay } = await openShell(page, {
    theme: "buzz",
    path: channelPath(),
    relay: { onFrame: (frame) => frames.push({ at: Date.now(), frame }) },
    extra: (base) => buildTaskStatus(base).events,
  });
  const channel = fixture.channels.ops;
  const author = fixture.agents.cereal.pubkey;
  const stamp = now();
  relay.push(
    mockEvent({
      id: "8b".repeat(32),
      kind: 9,
      pubkey: author,
      created_at: stamp,
      tags: [["h", channel]],
      content: "Picked up: Audit the release signing settings",
    }),
    lifecycleHead(
      author,
      channel,
      "qa-late-final",
      "running",
      stamp,
      stamp - 10,
    ),
  );
  const rail = page.getByTestId("work-rail");
  const running = rail.locator('[data-row-key$=":qa-late-final"]');
  await expect(running.getByTestId("work-row-ask")).toHaveText(
    "Picked up: Audit the release signing settings",
    { timeout: 10_000 },
  );
  const ended = now() + 1;
  relay.push(
    lifecycleHead(author, channel, "qa-late-final", "done", ended, stamp - 10),
  );
  await expect(running).toHaveCount(0);
  await rail.getByRole("button", { name: /Done today/ }).click();
  const done = rail
    .getByTestId("done-row")
    .filter({ hasText: "Cereal Killer" })
    .filter({ hasText: "#ops" });
  await expect(done.getByTestId("work-row-ask")).toHaveText(
    "Picked up: Audit the release signing settings",
    { timeout: 10_000 },
  );
  // Provider debounce is 2 s; history has now received and closed at EOSE.
  await page.waitForTimeout(3_000);
  relay.push(
    mockEvent({
      id: "8c".repeat(32),
      kind: 9,
      pubkey: author,
      created_at: ended + 5,
      tags: [["h", channel]],
      content: "Signing audit complete: all settings correct\nDetailed results",
    }),
  );
  try {
    await expect(done.getByTestId("work-row-ask")).toHaveText(
      "Signing audit complete: all settings correct",
      { timeout: 10_000 },
    );
  } finally {
    await saveFrames("late-final-requests.json", frames);
    await saveFrames(
      "late-final-stored-event.json",
      relay.served().find((event) => event.id === "8c".repeat(32)),
    );
    await done.scrollIntoViewIfNeeded();
    await shot(page, "qa-done-late-final");
    await done.screenshot({
      path: test.info().outputPath("late-final-done-row.png"),
    });
  }
});
