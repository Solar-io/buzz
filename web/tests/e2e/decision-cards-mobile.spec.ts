import { expect, test, type Page } from "@playwright/test";
import { decode as nip19Decode } from "nostr-tools/nip19";

import { publishAs, type UnsignedTemplate } from "./helpers/relaySeed";
import { signIn } from "./helpers/signIn";

/**
 * A decision card answered end to end ON A PHONE, in the bottom sheet.
 *
 * The unit suite proves the sheet's wiring (`DecisionCard.test.mjs` drives the
 * portaled sheet, not the inline stepper). It cannot prove the two things this
 * spec exists for, because neither is reachable without layout:
 *
 * 1. **The sheet fits.** `max-h-[85dvh]` is a CSS class; jsdom has no layout,
 *    so nothing short of a real viewport can tell a capped sheet from an
 *    uncapped one. A bottom-anchored panel with no cap grows UPWARD past the
 *    top of the screen, taking its own title with it — which is the exact
 *    failure the sheet was built to end.
 * 2. **The timeline behind it does not move.** That is the whole point of
 *    R5: at 390×844 the timeline scroller is bottom-pinned, so an inline card
 *    that grows loses its top to the growth. The sheet is only a fix if
 *    driving it leaves the scroller alone, and only a real scroller has a
 *    `scrollTop` to watch.
 *
 * Requires `E2E_RELAY_WS` and a build whose `VITE_RELAY_URL` points at the
 * same relay — the `wake-collapse.spec.ts` contract. It ALSO requires an
 * attested agent identity: channel membership is not relay membership, and a
 * freshly generated key is refused at AUTH with `restricted: not a relay
 * member` (measured 2026-09-20) before it can seed anything. Skips rather
 * than passing on a browser that reached nothing.
 */

const RELAY_WS = process.env.E2E_RELAY_WS ?? "";
const AGENT_NSEC = process.env.E2E_AGENT_NSEC ?? "";
const AUTH_TAG = process.env.E2E_AUTH_TAG ?? "";

/** 390×844 — the plan's target viewport, and R5's measurement viewport. */
const VIEWPORT = { width: 390, height: 844 };

/**
 * Deliberately TALL: eight long options with descriptions on the question the
 * sheet opens on. A short card would fit inside 85 dvh on its own and the
 * height assertions below would then pass with or without the cap — the
 * equal-on-both-sides trap. This card cannot fit, so the cap is the only
 * thing that can keep the sheet on screen.
 */
const CARD = {
  v: 2,
  title: "Mobile sheet e2e",
  body: "Seeded by decision-cards-mobile.spec.ts — safe to ignore.",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which surfaces should the fix cover?",
      body: "Long on purpose: this question is what makes the sheet taller than the viewport.",
      options: Array.from({ length: 8 }, (_, index) => ({
        id: `s${index}`,
        label: `Surface ${index + 1} — a deliberately long option label that wraps`,
        description:
          "And a description under it, so every row is two lines tall.",
      })),
    },
    {
      id: "extras",
      question: "Which extras?",
      multiSelect: true,
      options: [
        { id: "docs", label: "Docs" },
        { id: "tests", label: "Tests" },
      ],
    },
    {
      id: "when",
      question: "When?",
      options: [
        { id: "now", label: "Tonight" },
        { id: "mon", label: "Monday" },
      ],
    },
    {
      id: "who",
      question: "Who reviews?",
      options: [
        { id: "sam", label: "Sam" },
        { id: "nobody", label: "Nobody" },
      ],
    },
  ],
};

/** The channel timeline's scroll offset, or null when it is not mounted. */
async function timelineScrollTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector("div.buzz-timeline-scrollbar");
    return el ? el.scrollTop : null;
  });
}

test.describe("decision cards on a phone", () => {
  test.skip(
    !RELAY_WS || !AGENT_NSEC || !AUTH_TAG,
    "needs E2E_RELAY_WS + E2E_AGENT_NSEC + E2E_AUTH_TAG (see the header)",
  );
  test.use({ viewport: VIEWPORT });

  let secretKey: Uint8Array;

  test.beforeAll(() => {
    const decoded = nip19Decode(AGENT_NSEC);
    if (decoded.type !== "nsec") {
      throw new Error("E2E_AGENT_NSEC must be an nsec1… key");
    }
    secretKey = decoded.data;
  });

  /**
   * A private channel holding exactly one unanswered card, seeded fresh PER
   * TEST.
   *
   * Not shared: answering a card is terminal and permanent (that is the point
   * of the D1 fix), so a second test against the same card finds a "You
   * replied" row and no Answer button at all. Sharing one channel made
   * exactly that happen — the second test timed out looking for a tile the
   * first test had correctly retired.
   */
  async function seedCardChannel(): Promise<string> {
    const channelId = crypto.randomUUID();
    const seed: UnsignedTemplate[] = [
      {
        kind: 9007,
        tags: [
          ["h", channelId],
          ["name", `cards-mobile-${channelId.slice(0, 6)}`],
          ["visibility", "private"],
          ["channel_type", "stream"],
        ],
        content: "",
      },
      {
        kind: 9,
        tags: [
          ["h", channelId],
          ["card", JSON.stringify(CARD)],
        ],
        content: "Mobile sheet e2e — a decision card for the sheet spec.",
      },
    ];
    await publishAs(RELAY_WS, secretKey, seed, AUTH_TAG);
    return channelId;
  }

  test("the sheet fits the viewport and answers the whole interview", async ({
    page,
  }) => {
    const channelId = await seedCardChannel();
    await signIn(page, `/repos?c=${channelId}`, secretKey, AUTH_TAG);

    // The phone row is a TILE. The inline stepper exists in the DOM (the
    // split is a CSS breakpoint) and must not be VISIBLE here — that is the
    // assertion that fails if the `md:` classes are ever inverted.
    const tile = page.getByTestId("card-summary-tile");
    await expect(tile).toBeVisible();
    await expect(page.getByTestId("card-interview-progress")).toBeHidden();

    const restingScroll = await timelineScrollTop(page);
    expect(restingScroll).not.toBeNull();

    await page.getByTestId("card-summary-answer").click();
    const sheet = page.getByTestId("card-interview-sheet");
    await expect(sheet).toBeVisible();

    // --- The height contract. `max-h-[85dvh]` is what these measure. ---
    //
    // Two measurement traps, both hit for real while writing this:
    //
    // 1. `getBoundingClientRect`, NOT Playwright's `boundingBox()` — the
    //    latter is DOCUMENT-relative, and the shell's document is scrolled at
    //    this viewport, so a correctly placed fixed sheet read as bottom 1396
    //    in an 844 px window.
    // 2. WAIT FOR THE ENTER ANIMATION. `toBeVisible()` resolves the moment the
    //    sheet is in the DOM, and `slide-in-from-bottom` starts it translated
    //    a full sheet-height DOWN — measuring there reads a bottom of ~1561
    //    and indicts a sheet that is about to be exactly right.
    const box = await sheet.evaluate(async (node) => {
      await Promise.all(
        node
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        viewport: window.innerHeight,
      };
    });
    const cap = box.viewport * 0.85;
    // Tall enough that the cap is doing work: an uncapped sheet around this
    // card is far taller than the screen, so these cannot pass both ways.
    expect(box.height).toBeGreaterThan(box.viewport / 2);
    expect(box.height).toBeLessThanOrEqual(cap + 1);
    // And entirely ON the screen — a bottom-anchored panel with no cap grows
    // upward, so its top goes negative and its title leaves the viewport.
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.viewport + 1);

    // Question one, answered inside the sheet.
    await sheet.getByTestId("card-interview-option-s2").click();
    expect(await timelineScrollTop(page)).toBe(restingScroll);

    // Question two: multi-select, then Continue.
    await sheet.getByTestId("card-interview-option-tests").click();
    await sheet.getByTestId("card-interview-continue").click();
    expect(await timelineScrollTop(page)).toBe(restingScroll);

    // Question three: a TYPED answer, given entirely in the sheet.
    await sheet.getByTestId("card-interview-something-else").click();
    await sheet.getByTestId("card-interview-input").fill("after the release");
    await sheet.getByTestId("card-interview-send-typed").click();
    expect(await timelineScrollTop(page)).toBe(restingScroll);

    // Question four auto-submits, which closes the sheet and makes the row
    // terminal — no tile, no options, nothing left to answer twice.
    await sheet.getByTestId("card-interview-option-sam").click();
    await expect(page.getByTestId("decision-card-sent")).toBeVisible();
    await expect(page.getByTestId("card-interview-sheet")).toHaveCount(0);
    await expect(page.getByTestId("card-summary-tile")).toHaveCount(0);
    await expect(page.getByTestId("decision-card-sent")).toContainText(
      "after the release",
    );
  });

  test("dismissing the sheet publishes nothing and keeps the draft", async ({
    page,
  }) => {
    const channelId = await seedCardChannel();
    await signIn(page, `/repos?c=${channelId}`, secretKey, AUTH_TAG);
    await page.getByTestId("card-summary-answer").click();
    const sheet = page.getByTestId("card-interview-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("card-interview-option-s0").click();

    // Backdrop tap: the dismissal a thumb finds by accident.
    await page
      .getByTestId("sheet-overlay")
      .click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId("card-interview-sheet")).toHaveCount(0);
    // Not answered — the row is still a tile, and it offers to RESUME.
    await expect(page.getByTestId("decision-card-sent")).toHaveCount(0);
    await expect(page.getByTestId("card-summary-answer")).toHaveText(
      "Resume — 1 of 4",
    );
  });
});
