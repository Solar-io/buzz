import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  hexId,
  type MockEvent,
  type MockRelay,
  mockEvent,
} from "./helpers/mockRelay";
import {
  channelPath,
  mainComposer,
  openShell,
  SHOTS_DIR,
  shot,
} from "./helpers/shellPage";
import type { WorkFixture } from "./helpers/workFixture";

/**
 * Web redesign Phase 3 — scratch channels — driven through the real sign-in
 * against the mocked relay: `/new` (create, roster copy, open), `/exit` (leave
 * now, Undo for 10 s, then the kind-9008), `/keep` (clear the TTL, rename),
 * the Scratch sidebar section, the header badge and the idle countdown.
 *
 * The mock is not a relay. `relaySideEffects` below plays the part of the
 * relay's side effects the client depends on — a 9007 becomes a 39000, each
 * 9000 re-signs the 39002 — so the CLIENT can be driven end to end; what the
 * real relay does with these events is the live check's job.
 *
 * `SHOTS_DIR` writes the Commands / Main (Scratch) comparison frames in both
 * fixed palettes at 1440 and 390.
 */

const RELAY = "ee".repeat(32);
const SCRATCH_ID = "30000000-0000-4000-8000-00000000000a";
const SCRATCH_2_ID = "30000000-0000-4000-8000-00000000000b";

const flight = channelPath("flight-path");
const tag = (event: MockEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

/**
 * Stand-in for the relay's side effects on 9007 / 9000 / 9002 / 9008. It
 * first learns the channels served from the start, so a 9002 on a seeded
 * scratch channel edits the 39000 the client actually has.
 */
function relaySideEffects() {
  let clock = Math.floor(Date.now() / 1000);
  let seq = 7_000;
  const metadata = new Map<string, string[][]>();
  const rosters = new Map<string, string[]>();
  let seeded = false;
  const learnSeed = (relay: MockRelay) => {
    if (seeded) {
      return;
    }
    seeded = true;
    for (const event of relay.served()) {
      const id = tag(event, "d") ?? "";
      if (event.kind === 39000) {
        metadata.set(id, event.tags);
      } else if (event.kind === 39002) {
        rosters.set(
          id,
          event.tags
            .filter((entry) => entry[0] === "p")
            .map((entry) => entry[1]),
        );
      }
    }
  };
  const signed = (kind: number, tags: string[][]) =>
    mockEvent({
      id: hexId(seq++, "f"),
      pubkey: RELAY,
      kind,
      created_at: ++clock,
      tags,
    });
  const d = (id: string) => (event: MockEvent) =>
    (event.kind === 39000 || event.kind === 39002) && tag(event, "d") === id;
  const emitMeta = (relay: MockRelay, id: string) => {
    relay.remove((event) => event.kind === 39000 && tag(event, "d") === id);
    // No live fan-out for 39000 on the real relay: served to the next REQ.
    relay.add(signed(39000, metadata.get(id) ?? []));
  };
  const emitRoster = (relay: MockRelay, id: string) => {
    relay.remove((event) => event.kind === 39002 && tag(event, "d") === id);
    relay.push(
      signed(39002, [
        ["d", id],
        ...(rosters.get(id) ?? []).map((pubkey) => ["p", pubkey]),
      ]),
    );
  };
  return (event: MockEvent, relay: MockRelay) => {
    learnSeed(relay);
    const id = tag(event, "h");
    if (!id) {
      return;
    }
    if (event.kind === 9007) {
      const ttl = Number(tag(event, "ttl"));
      metadata.set(id, [
        ["d", id],
        ["name", tag(event, "name") ?? id],
        ["about", tag(event, "about") ?? ""],
        ["private"],
        ["t", "stream"],
        ["ttl", String(ttl)],
        ["ttl_deadline", new Date((clock + ttl) * 1000).toISOString()],
      ]);
      rosters.set(id, [event.pubkey]);
      emitMeta(relay, id);
      emitRoster(relay, id);
    } else if (event.kind === 9000) {
      rosters.get(id)?.push(tag(event, "p") ?? "");
      emitRoster(relay, id);
    } else if (event.kind === 9002) {
      let tags = metadata.get(id) ?? [];
      if (tag(event, "ttl") === "") {
        tags = tags.filter((entry) => !entry[0].startsWith("ttl"));
      }
      const name = tag(event, "name");
      if (name) {
        tags = tags.map((entry) =>
          entry[0] === "name" ? ["name", name] : entry,
        );
      }
      metadata.set(id, tags);
      emitMeta(relay, id);
    } else if (event.kind === 9008) {
      relay.remove(d(id));
    }
  };
}

/** A scratch channel already on the relay: 39000 + its roster. */
function seededScratch(
  fixture: WorkFixture,
  options: { id: string; name: string; deadlineInS: number },
): MockEvent[] {
  const nowS = Math.floor(Date.now() / 1000);
  const parent = fixture.channels["flight-path"];
  return [
    mockEvent({
      id: hexId(Number.parseInt(options.id.slice(-2), 16) + 500, "e"),
      pubkey: RELAY,
      kind: 39000,
      created_at: nowS - 3600,
      tags: [
        ["d", options.id],
        ["name", options.name],
        ["about", `Cloned from #flight-path [parent:${parent}]`],
        ["private"],
        ["t", "stream"],
        ["ttl", "259200"],
        [
          "ttl_deadline",
          new Date((nowS + options.deadlineInS) * 1000).toISOString(),
        ],
      ],
    }),
    mockEvent({
      id: hexId(Number.parseInt(options.id.slice(-2), 16) + 600, "e"),
      pubkey: RELAY,
      kind: 39002,
      created_at: nowS - 3600,
      tags: [
        ["d", options.id],
        ["p", fixture.viewer, "", "owner"],
        ["p", fixture.agents.gilfoyle.pubkey],
        ["p", fixture.agents.nikon.pubkey],
      ],
    }),
  ];
}

/**
 * A frame with the Undo toast in it. `shot` settles every finite animation
 * first, and the toast's draining line IS a 10 s animation — waiting it out
 * would photograph the toast's absence and leave nothing to click.
 */
async function shotWithUndo(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) {
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

async function runCommand(page: Page, text: string): Promise<void> {
  const composer = mainComposer(page);
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

/** Messages that carried a slash command as text — must stay zero. */
function commandsSentAsText(relay: MockRelay): MockEvent[] {
  return relay.published.filter(
    (event) => event.kind === 9 && event.content.trimStart().startsWith("/"),
  );
}

const scratchSection = (page: Page) =>
  page.getByTestId("channel-sidebar").getByRole("region", { name: "Scratch" });

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`desktop 1440 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 960 } });

    test("/new copies the room into a private scratch channel and opens it", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const { fixture, relay } = await openShell(page, {
        theme,
        path: flight,
        fixture: { phase2: true },
        relay: { onPublish: relaySideEffects() },
      });
      await expect(page.getByTestId("channel-header")).toContainText(
        "flight-path",
      );
      // No scratch channel yet: no section, no /exit, no /keep.
      await expect(scratchSection(page)).toHaveCount(0);
      const composer = mainComposer(page);
      await composer.click();
      await composer.fill("/");
      const list = page.getByTestId("command-list");
      await expect(list).toContainText("This channel");
      await expect(list.getByTestId("command-option-new")).toContainText(
        "Scratch copy of #flight-path",
      );
      await expect(list.getByTestId("command-option-exit")).toHaveCount(0);
      await expect(list.getByTestId("command-option-keep")).toHaveCount(0);

      await composer.fill("/new");
      await composer.press("Enter");

      // 9007: private, the parent link, the 72 h idle TTL.
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 9007).length)
        .toBe(1);
      const create = relay.published.find((e) => e.kind === 9007) as MockEvent;
      const scratchId = tag(create, "h") as string;
      expect(tag(create, "name")).toBe("flight-path-scratch-1");
      expect(tag(create, "visibility")).toBe("private");
      expect(tag(create, "ttl")).toBe("259200");
      expect(tag(create, "about")).toBe(
        `Cloned from #flight-path [parent:${fixture.channels["flight-path"]}]`,
      );
      // One 9000 per member of the parent's roster except me, no role tag.
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 9000).length)
        .toBe(4);
      const adds = relay.published.filter((e) => e.kind === 9000);
      expect(adds.every((e) => tag(e, "h") === scratchId)).toBe(true);
      expect(adds.every((e) => tag(e, "role") === undefined)).toBe(true);
      expect(new Set(adds.map((e) => tag(e, "p")))).toEqual(
        new Set([
          fixture.agents.gilfoyle.pubkey,
          fixture.agents.nikon.pubkey,
          fixture.agents.acid.pubkey,
          fixture.agents.cereal.pubkey,
        ]),
      );
      expect(commandsSentAsText(relay)).toEqual([]);

      // Opened: the header badge, the banner, the Scratch section.
      await expect(page).toHaveURL(new RegExp(`c=${scratchId}`));
      const header = page.getByTestId("channel-header");
      await expect(header).toHaveAttribute("data-scratch", "true");
      await expect(header).toContainText("scratch-1");
      await expect(header.getByTestId("scratch-pill")).toHaveText("SCRATCH");
      await expect(header.getByTestId("scratch-origin")).toContainText(
        "cloned from #flight-path · 4 agents",
      );
      await expect(page.getByTestId("scratch-banner")).toContainText(
        "Same people and agents as #flight-path",
      );
      await expect(scratchSection(page)).toContainText(
        "flight-path / scratch-1",
      );
      await expect(
        page.getByText("Opened flight-path / scratch-1 with 4 members"),
      ).toBeVisible();
      // 72 h to go: no countdown anywhere.
      await expect(page.getByTestId("scratch-countdown")).toHaveCount(0);
      await expect(page.getByTestId("channel-expiry-badge")).toHaveCount(0);

      // In here the list offers the channel's own commands, in its terms.
      await composer.click();
      await composer.fill("/");
      await expect(list.getByTestId("command-option-exit")).toContainText(
        "Discard scratch-1 and go back to #flight-path",
      );
      await expect(list.getByTestId("command-option-keep")).toContainText(
        "Make this a permanent channel",
      );
      await expect(list.getByTestId("command-option-new")).toContainText(
        "Another scratch copy",
      );
      expect(pageErrors).toEqual([]);
      await shot(page, `scratch-commands-${theme}-1440`);
      await composer.fill("");
      await shot(page, `scratch-main-${theme}-1440`);

      // A second /new from inside is a sibling of the ROOT parent.
      await runCommand(page, "/new jitter qa");
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 9007).length)
        .toBe(2);
      const sibling = relay.published.filter((e) => e.kind === 9007)[1];
      expect(tag(sibling, "name")).toBe("flight-path-jitter-qa");
      expect(tag(sibling, "about")).toContain(
        `[parent:${fixture.channels["flight-path"]}]`,
      );
      await expect(scratchSection(page)).toContainText(
        "flight-path / jitter-qa",
      );
    });

    test("/exit leaves at once, Undo brings it back, the delete waits 10 s", async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const { fixture, relay } = await openShell(page, {
        theme,
        path: () => `/repos?c=${SCRATCH_ID}`,
        fixture: { phase2: true },
        extra: (f) =>
          seededScratch(f, {
            id: SCRATCH_ID,
            name: "flight-path-scratch-1",
            deadlineInS: 259_000,
          }),
        relay: { onPublish: relaySideEffects() },
      });
      const parentId = fixture.channels["flight-path"];
      const deletes = () => relay.published.filter((e) => e.kind === 9008);
      await expect(page.getByTestId("channel-header")).toHaveAttribute(
        "data-scratch",
        "true",
      );

      await runCommand(page, "/exit");
      // Gone at once: back in the parent, out of the sidebar, Undo offered.
      await expect(page).toHaveURL(new RegExp(`c=${parentId}`));
      await expect(scratchSection(page)).toHaveCount(0);
      const undo = page.getByTestId("buzz-toast-undo");
      await expect(undo).toContainText("Left flight-path / scratch-1");
      await shotWithUndo(page, `scratch-exit-${theme}-1440`);
      await undo.getByRole("button", { name: "Undo" }).click();
      await expect(page).toHaveURL(new RegExp(`c=${SCRATCH_ID}`));
      await expect(scratchSection(page)).toContainText(
        "flight-path / scratch-1",
      );
      // Past the window: an undone exit deletes nothing.
      await page.waitForTimeout(10_500);
      expect(deletes()).toEqual([]);

      // Exit again, from the header button this time, and let it run out.
      await page.getByTestId("scratch-exit").click();
      await expect(page).toHaveURL(new RegExp(`c=${parentId}`));
      await page.mouse.move(1, 1);
      await page.waitForTimeout(5_000);
      expect(deletes(), "nothing before the Undo window closes").toEqual([]);
      await expect.poll(() => deletes().length, { timeout: 10_000 }).toBe(1);
      expect(deletes()[0].tags).toEqual([["h", SCRATCH_ID]]);
      await expect(page.getByTestId("buzz-toast-undo")).toHaveCount(0);
      await expect(scratchSection(page)).toHaveCount(0);
      expect(commandsSentAsText(relay)).toEqual([]);
    });

    test("/keep clears the ttl and renames; a refusal reads in the relay's words", async ({
      page,
    }) => {
      let refusals = 0;
      const { relay } = await openShell(page, {
        theme,
        path: () => `/repos?c=${SCRATCH_ID}`,
        fixture: { phase2: true },
        extra: (f) =>
          seededScratch(f, {
            id: SCRATCH_ID,
            name: "flight-path-scratch-1",
            deadlineInS: 259_000,
          }),
        relay: {
          onPublish: relaySideEffects(),
          rejectPublish: (event) =>
            event.kind === 9002 && refusals++ === 0
              ? "restricted: actor not authorized for name/about/archived/visibility/ttl changes"
              : null,
        },
      });
      await expect(page.getByTestId("channel-header")).toHaveAttribute(
        "data-scratch",
        "true",
      );
      await runCommand(page, "/keep");
      await expect(page.getByTestId("composer-command-error")).toContainText(
        "actor not authorized for name/about/archived/visibility/ttl changes",
      );
      await runCommand(page, "/keep capture-plan");
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 9002).length)
        .toBe(2);
      expect(relay.published.filter((e) => e.kind === 9002)[1].tags).toEqual([
        ["h", SCRATCH_ID],
        ["ttl", ""],
        ["name", "capture-plan"],
      ]);
      // Permanent now: out of Scratch, into Channels, an ordinary header.
      await expect(scratchSection(page)).toHaveCount(0);
      await expect(
        page
          .getByTestId("channel-sidebar")
          .getByRole("region", { name: "Channels" }),
      ).toContainText("capture-plan");
      const header = page.getByTestId("channel-header");
      await expect(header).toContainText("capture-plan");
      await expect(header).not.toHaveAttribute("data-scratch", "true");
      // Its provenance stays, without the machine marker.
      await expect(header).toContainText("Cloned from #flight-path");
      await expect(header).not.toContainText("[parent:");
      expect(commandsSentAsText(relay)).toEqual([]);
    });

    test("a member the relay refuses is named; the idle countdown shows in the last hour", async ({
      page,
    }) => {
      // The refusal names a key the fixture only mints inside openShell.
      const refuse = { pubkey: "" };
      const { fixture } = await openShell(page, {
        theme,
        path: flight,
        fixture: { phase2: true },
        extra: (f) =>
          seededScratch(f, {
            id: SCRATCH_2_ID,
            name: "flight-path-scratch-2",
            deadlineInS: 40 * 60,
          }),
        relay: {
          onPublish: relaySideEffects(),
          rejectPublish: (event) =>
            event.kind === 9000 && tag(event, "p") === refuse.pubkey
              ? "policy:owner_only — only the agent owner can add this agent"
              : null,
        },
      });
      refuse.pubkey = fixture.agents.cereal.pubkey;

      // The seeded scratch is 40 min from its idle expiry: it counts down.
      await scratchSection(page).getByText("flight-path / scratch-2").click();
      await expect(page).toHaveURL(new RegExp(`c=${SCRATCH_2_ID}`));
      await expect(page.getByTestId("scratch-countdown")).toHaveText(
        /^(40|39)m left$/,
      );
      await shot(page, `scratch-countdown-${theme}-1440`);

      await page
        .getByTestId("channel-sidebar")
        .getByRole("region", { name: "Channels" })
        .getByText("flight-path", { exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`c=${fixture.channels["flight-path"]}`),
      );
      await runCommand(page, "/new");
      await expect(
        page.getByText(
          "1 of 4 members could not be added to flight-path / scratch-3",
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          "policy:owner_only — only the agent owner can add this agent",
          {
            exact: false,
          },
        ),
      ).toBeVisible();
      // The channel exists regardless, and is open.
      await expect(page.getByTestId("channel-header")).toHaveAttribute(
        "data-scratch",
        "true",
      );
    });
  });

  test.describe(`phone 390 · ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("a scratch channel on a phone: title, banner, Keep and Exit", async ({
      page,
    }) => {
      const { fixture, relay } = await openShell(page, {
        theme,
        path: () => `/repos?c=${SCRATCH_ID}`,
        fixture: { phase2: true },
        extra: (f) =>
          seededScratch(f, {
            id: SCRATCH_ID,
            name: "flight-path-scratch-1",
            deadlineInS: 30 * 60,
          }),
        relay: { onPublish: relaySideEffects() },
      });
      await expect(page.getByTestId("app-shell-phone-bar")).toContainText(
        "flight-path / scratch-1",
      );
      const banner = page.getByTestId("scratch-banner");
      await expect(banner.getByTestId("scratch-pill")).toBeVisible();
      // In the last hour the countdown takes the "from #parent" room (the
      // top bar already names the parent).
      await expect(banner.getByTestId("scratch-countdown")).toHaveText(
        /^(30|29)m left$/,
      );
      await expect(banner).not.toContainText("from #");
      await expect(banner.getByTestId("scratch-keep")).toBeVisible();
      await expect(banner.getByTestId("scratch-exit")).toBeVisible();
      // Nothing pushes the page sideways at phone width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const box = await banner.boundingBox();
      expect(box && box.x + box.width).toBeLessThanOrEqual(390);
      await shot(page, `scratch-phone-${theme}-390`);

      await banner.getByTestId("scratch-exit").click();
      await expect(page).toHaveURL(
        new RegExp(`c=${fixture.channels["flight-path"]}`),
      );
      await expect(page.getByTestId("buzz-toast-undo")).toContainText(
        "Left flight-path / scratch-1",
      );
      await shotWithUndo(page, `scratch-phone-exit-${theme}-390`);
      await page
        .getByTestId("buzz-toast-undo")
        .getByRole("button", { name: "Undo" })
        .click();
      await expect(page).toHaveURL(new RegExp(`c=${SCRATCH_ID}`));
      expect(relay.published.filter((e) => e.kind === 9008)).toEqual([]);
    });
  });
}
