import { expect, type Page, test } from "@playwright/test";

import type { MockEvent } from "./helpers/mockRelay";
import {
  channelPath,
  mainComposer,
  openShell,
  shot,
} from "./helpers/shellPage";
import type { WorkFixture } from "./helpers/workFixture";

/**
 * Web redesign Phase 2, driven through the real sign-in against the mocked
 * relay: readable messages (table card, callouts, file tiles, the handoff
 * bar), the slash-command registry, ⌘K jump, yes/no quick replies, Feedback
 * from the hover bar, and the decision card's phone sheet.
 *
 * What only this layer can prove: every surface here is fed by an EVENT the
 * relay served or received — a component that renders correctly and that
 * nothing reaches reads exactly like a working one in the unit suite.
 *
 * `SHOTS_DIR` writes the Message / Commands / Jump / PhoneAsk / PhoneChannel
 * comparison frames in both fixed palettes.
 */

const flight = channelPath("flight-path");

function find(fixture: WorkFixture, prefix: string): MockEvent {
  const event = fixture.events.find((candidate) =>
    candidate.content.startsWith(prefix),
  );
  expect(event, `fixture event "${prefix}"`).toBeTruthy();
  return event as MockEvent;
}

async function typeInComposer(page: Page, text: string): Promise<void> {
  const composer = mainComposer(page);
  await composer.click();
  await composer.fill(text);
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test.describe(`desktop 1440 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 960 } });

    test("a long agent message reads: table, callouts, files, handoff", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const { fixture } = await openShell(page, {
        theme,
        path: flight,
        fixture: { phase2: true },
      });

      // Header: title, topic and the people in it.
      const header = page.getByTestId("channel-header");
      await expect(header).toContainText("flight-path");
      await expect(header).toContainText("capture plan");

      // The table is a card with its numeric column right-aligned.
      const table = page.getByTestId("markdown-table").first();
      await expect(table).toBeVisible();
      await expect(table).toContainText("Desktop compose");
      // Callouts by kind, and the marker text never leaks.
      await expect(page.locator('[data-callout="note"]')).toContainText(
        "cold start",
      );
      await expect(page.locator('[data-callout="warning"]')).toContainText(
        "Reduce Motion",
      );
      await expect(page.getByText("[!NOTE]")).toHaveCount(0);
      // Three attachments alone in a paragraph: one tile group.
      const tiles = page.getByTestId("file-tile-group");
      await expect(tiles.getByTestId("file-tile")).toHaveCount(3);
      await expect(tiles).toContainText("capture-plan.pdf");
      // The /handoff bar reads the seat's receipt (💬 = working).
      const handoff = page.getByTestId("handoff-chip");
      await expect(handoff).toContainText("Lord Nikon");
      await expect(handoff.getByTestId("handoff-status")).toContainText(
        "working",
      );
      // The sidebar row carries the channel's own status marker.
      await expect(
        page.getByTestId("channel-sidebar").getByTestId("sidebar-row-needs"),
      ).not.toHaveCount(0);
      expect(pageErrors).toEqual([]);
      await shot(page, `message-${theme}-1440`);

      // The card at the bottom: title once in its header, options below.
      // (Before scrolling up: the virtualizer unmounts rows it leaves.)
      const card = page.getByTestId("decision-card").last();
      await expect(card).toContainText("Beat 03 hold");
      await expect(card.getByTestId("decision-card-recommended")).toBeVisible();
      expect(find(fixture, "**Beat 03 hold").id).toBeTruthy();

      await table.scrollIntoViewIfNeeded();
      await shot(page, `message-table-${theme}-1440`);
    });

    test("slash commands run from the composer and are never sent as text", async ({
      page,
    }) => {
      const { fixture, relay } = await openShell(page, {
        theme,
        path: flight,
        fixture: { phase2: true },
      });
      await expect(page.getByTestId("channel-header")).toBeVisible();

      await typeInComposer(page, "/");
      const list = page.getByTestId("command-list");
      await expect(list).toBeVisible();
      await expect(list.getByTestId("command-option-remind")).toBeVisible();
      await expect(list.getByTestId("command-option-handoff")).toBeVisible();
      await expect(list.getByTestId("command-option-status")).toBeVisible();
      await shot(page, `commands-${theme}-1440`);

      // Unknown: an inline error, nothing on the wire. (Typing indicators do
      // go out while composing — count only messages and reminders.)
      const sent = () =>
        relay.published.filter((e) => e.kind === 9 || e.kind === 30300).length;
      const before = sent();
      await typeInComposer(page, "/deploy now");
      await mainComposer(page).press("Enter");
      await expect(page.getByTestId("composer-command-error")).toContainText(
        "/deploy",
      );
      expect(sent()).toBe(before);

      // /remind 2h files a reminder on the card aimed at me (kind 30300),
      // and no kind 9 carries the command text.
      await typeInComposer(page, "/remind 2h");
      await mainComposer(page).press("Enter");
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 30300).length)
        .toBe(1);
      expect(
        relay.published.some(
          (event) => event.kind === 9 && event.content.startsWith("/"),
        ),
      ).toBe(false);
      await expect(mainComposer(page)).toHaveValue("");

      // /handoff @seat <task> publishes ONE message with the handoff tag.
      // The seat is picked from the @ list, as a person would.
      await typeInComposer(page, "/handoff @Lord");
      await expect(
        page.getByRole("button", { name: "@Lord Nikon", exact: true }),
      ).toBeVisible();
      await mainComposer(page).press("Enter");
      // The pick moves the caret on the next frame; type after it lands.
      await expect(mainComposer(page)).toHaveValue("/handoff @Lord Nikon ");
      await page.waitForTimeout(50);
      await mainComposer(page).pressSequentially("retake beat 03");
      await mainComposer(page).press("Enter");
      await expect
        .poll(() =>
          relay.published.find((event) =>
            event.tags.some((tag) => tag[0] === "handoff"),
          ),
        )
        .toBeTruthy();
      const handoff = relay.published.find((event) =>
        event.tags.some((tag) => tag[0] === "handoff"),
      );
      expect(handoff?.content).toBe("@Lord Nikon retake beat 03");
      expect(handoff?.tags).toContainEqual([
        "handoff",
        fixture.agents.nikon.pubkey,
      ]);
    });

    test("⌘K jumps: ghost completion, Tab accepts, scopes and messages", async ({
      page,
    }) => {
      await openShell(page, {
        theme,
        path: flight,
        fixture: { phase2: true },
      });
      await expect(page.getByTestId("channel-header")).toBeVisible();
      await page.keyboard.press("ControlOrMeta+k");
      const panel = page.getByTestId("search-panel");
      await expect(panel).toBeVisible();
      const input = panel.getByTestId("search-input");
      await input.fill("eng");
      await expect(panel.getByTestId("jump-ghost")).toHaveText("ineering");
      await shot(page, `jump-${theme}-1440`);
      await input.press("Tab");
      await expect(input).toHaveValue("engineering");
      await input.press("Enter");
      await expect(page.getByTestId("channel-header")).toContainText(
        "engineering",
      );

      // A # scope narrows to channels; "Search messages for" switches mode.
      await page.keyboard.press("ControlOrMeta+k");
      await panel.getByTestId("search-input").fill("#fli");
      await expect(
        panel.getByRole("option", { name: /flight-path/ }),
      ).toBeVisible();
      await panel.getByTestId("search-input").fill("jitter");
      await expect(panel.getByTestId("search-result-messages")).toBeVisible();
      await page.keyboard.press("Escape");
    });

    test("an explicit yes/no ask grows quick replies; Yes is an ordinary reply", async ({
      page,
    }) => {
      const { fixture, relay } = await openShell(page, {
        theme,
        path: channelPath("dm-gilfoyle"),
        fixture: { phase2: true },
      });
      const ask = find(fixture, "Try Sol max");
      const replies = page.getByTestId("quick-replies");
      await expect(replies).toBeVisible();
      await expect(replies.getByTestId("quick-reply-yes")).toBeVisible();
      await expect(replies.getByTestId("quick-reply-feedback")).toBeVisible();
      // The older card in the same DM never grows buttons: it IS the ask UI.
      await expect(page.getByTestId("quick-replies")).toHaveCount(1);
      await shot(page, `quick-reply-${theme}-1440`);

      await replies.getByTestId("quick-reply-yes").click();
      await expect(page.getByTestId("quick-reply-sent")).toContainText(
        "You answered Yes",
      );
      const sent = relay.published.find(
        (event) => event.kind === 9 && event.content === "Yes",
      );
      expect(sent?.tags).toContainEqual(["e", ask.id, "", "reply"]);
      expect(sent?.tags).toContainEqual(["p", fixture.agents.gilfoyle.pubkey]);
    });

    test("Feedback on the hover bar files the message for tomorrow 9:00 AM", async ({
      page,
    }) => {
      const { fixture, relay } = await openShell(page, {
        theme,
        path: flight,
        fixture: { phase2: true },
      });
      const target = find(fixture, "Capture notes for beat 02.");
      const row = page.getByTestId(`message-row-${target.id}`);
      await row.hover();
      await page.getByTestId(`feedback-message-${target.id}`).click();
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 30300).length)
        .toBe(1);
      await expect(
        page.getByText(/Sent to Feedback · due tomorrow 9:00/),
      ).toBeVisible();
    });
  });

  test.describe(`phone 390 · ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("a channel on a phone: members subtitle, compact composer", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await openShell(page, {
        theme,
        path: flight,
        fixture: { phase2: true },
      });
      await expect(page.getByTestId("phone-bar-subtitle")).toBeVisible();
      // The desktop header is not doubled under the phone bar.
      await expect(page.getByTestId("channel-header")).toHaveCount(0);
      await expect(page.getByTestId("handoff-chip")).toBeVisible();
      expect(pageErrors).toEqual([]);
      await shot(page, `phone-channel-p2-${theme}-390`);
    });

    test("an interview answers in a sheet: asker, progress, Edit, Feedback", async ({
      page,
    }) => {
      const { relay } = await openShell(page, {
        theme,
        path: channelPath("dm-esp32"),
        fixture: { phase2: true },
      });
      const tile = page.getByTestId("card-summary-tile");
      await expect(tile).toBeVisible();
      await page.getByTestId("card-summary-answer").click();
      const sheet = page.getByTestId("card-interview-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("ESP32 asks");
      await sheet.getByTestId("card-interview-option-en").click();
      await expect(sheet).toContainText("Which wake word");
      await expect(sheet.getByTestId("card-interview-previous")).toContainText(
        "English",
      );
      // Let the slide-in finish before the frame (AGENTS.md: toBeVisible
      // resolves mid-animation).
      await page.waitForTimeout(400);
      await shot(page, `phone-ask-${theme}-390`);

      // Not now, send to Feedback: files it, closes, answers nothing.
      await sheet.getByTestId("card-interview-feedback").click();
      await expect(sheet).toHaveCount(0);
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 30300).length)
        .toBe(1);
      expect(relay.published.filter((e) => e.kind === 9)).toHaveLength(0);
      await expect(page.getByTestId("card-summary-answer")).toHaveText(
        "Resume — 1 of 3",
      );
    });
  });
}
