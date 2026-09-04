import { expect, type Page, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";

import {
  hexId,
  installMockRelay,
  mockEvent,
  type MockEvent,
  type MockRelay,
} from "./helpers/mockRelay";

/**
 * The forum list, driven with real posts.
 *
 * Two claims are made here that no unit test can make:
 *
 *  1. the post list is virtualized — it renders a WINDOW of its rows, and rows
 *     outside that window are absent from the DOM until they are scrolled to.
 *     A list that mounted all 240 cards would pass any test that only looked
 *     for a post, so the assertion is on the COUNT and on a specific late post
 *     being absent and then present.
 *  2. deleting a post goes through a menu and a dialog, and actually publishes
 *     a delete. The old `window.confirm` is invisible to Playwright — the
 *     browser auto-dismisses it, so a spec that clicked the trash glyph and
 *     asserted "no dialog appeared" would have passed against the OLD code
 *     too. Asserting the dialog, and then the published event, discriminates.
 */

const CHANNEL_ID = "5b1f2a34-1111-4222-8333-444455556666";
const POST_COUNT = 240;

/** Enroll `secretKey` at `path` through the real manual-entry form. */
async function signIn(
  page: Page,
  path: string,
  secretKey: Uint8Array,
): Promise<void> {
  await page.goto(path);
  await page.getByRole("button", { name: "Enter key manually" }).click();
  await page.getByPlaceholder("nsec1…").fill(nsecEncode(secretKey));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("New passphrase").fill("e2e-passphrase");
  await page.getByPlaceholder("Confirm passphrase").fill("e2e-passphrase");
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(
    page.getByRole("button", { name: "Enter key manually" }),
  ).toBeHidden();
}

/** The kind-39000 metadata that makes the shell render a forum body. */
function forumChannelEvent(): MockEvent {
  return mockEvent({
    id: hexId(1),
    kind: 39000,
    created_at: 1_756_000_000,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "forum-parity"],
      ["t", "forum"],
    ],
  });
}

/**
 * `POST_COUNT` kind-45001 posts, newest first once the view sorts them.
 * `author` is the signed-in key so the delete affordance is offered — the
 * card gates it on `selfPubkey === post.authorPubkey`.
 */
function forumPosts(author: string): MockEvent[] {
  return Array.from({ length: POST_COUNT }, (_, index) =>
    mockEvent({
      id: hexId(1000 + index, "a"),
      pubkey: author,
      kind: 45001,
      created_at: 1_756_000_000 + index,
      tags: [["h", CHANNEL_ID]],
      content: `Post number ${index}`,
    }),
  );
}

/**
 * Everything is seeded BEFORE the page loads. The mock has no live fan-out —
 * it answers REQs from a fixed set — so an event added after the client has
 * already subscribed would never be delivered, and the spec would fail for a
 * reason that has nothing to do with the code under test.
 */
async function openForum(page: Page): Promise<{
  relay: MockRelay;
  author: string;
}> {
  const secretKey = generateSecretKey();
  const author = getPublicKey(secretKey);
  const relay = await installMockRelay(page, [
    forumChannelEvent(),
    ...forumPosts(author),
  ]);
  await signIn(page, `/repos?c=${CHANNEL_ID}`, secretKey);
  return { relay, author };
}

test("the forum post list virtualizes: a window of rows, not all of them", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openForum(page);

  const list = page.getByTestId("forum-post-list");
  await expect(list).toBeVisible();
  const cards = page.getByTestId("forum-post-card");
  await expect(cards.first()).toBeVisible();

  // Newest first: the last-created post leads.
  await expect(cards.first()).toContainText(`Post number ${POST_COUNT - 1}`);

  // The window. A non-virtualized list would mount all POST_COUNT cards; the
  // bound is deliberately loose (virtua's overscan is not a fixed number) but
  // far below the total, so it discriminates without being brittle.
  const mounted = await cards.count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(POST_COUNT / 2);

  // A post deep in the list is not in the DOM at all until it is scrolled to.
  const deepPost = page.getByText("Post number 3", { exact: true });
  await expect(deepPost).toHaveCount(0);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByTestId("forum-load-older")).toBeVisible();
  await expect(deepPost).toBeVisible();

  // And the window still is a window after scrolling — the rows that scrolled
  // out were unmounted rather than accumulating.
  expect(await cards.count()).toBeLessThan(POST_COUNT / 2);
  expect(pageErrors).toEqual([]);
});

test("deleting a post uses a menu and a confirm dialog, and publishes a delete", async ({
  page,
}) => {
  const { relay } = await openForum(page);

  const firstCard = page.getByTestId("forum-post-card").first();
  await expect(firstCard).toBeVisible();
  const newestId = hexId(1000 + POST_COUNT - 1, "a");

  // The menu, not a bare trash glyph.
  const trigger = page.getByTestId(`forum-post-menu-${newestId}`);
  await trigger.click();
  const item = page.getByTestId(`forum-post-menu-${newestId}-delete`);
  await expect(item).toBeVisible();
  await expect(item).toContainText("Delete post");
  await item.click();

  // The dialog is in-page — a `window.confirm` would have been auto-dismissed
  // by the browser and nothing would be visible here.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Delete post?");
  await expect(dialog).toContainText("cannot be undone");

  // Cancelling deletes nothing. Scoped to deletions rather than to "nothing
  // was published at all": a live shell also publishes presence (kind 20001),
  // and an assertion on the whole stream would fail for that instead.
  const deletions = () =>
    relay.published.filter(
      (event) =>
        event.kind === 5 &&
        event.tags.some((tag) => tag[0] === "e" && tag[1] === newestId),
    );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(deletions()).toEqual([]);

  await trigger.click();
  await page.getByTestId(`forum-post-menu-${newestId}-delete`).click();
  await page.getByTestId(`forum-post-menu-${newestId}-confirm`).click();

  // The delete reached the relay, naming the post the menu was opened on and
  // the channel it lives in — the shape `deleteChannelMessage` promises.
  await expect.poll(() => deletions().length, { timeout: 5_000 }).toBe(1);
  expect(deletions()[0].tags).toContainEqual(["h", CHANNEL_ID]);
});

/**
 * `ForumThreadView` carried the same `window.confirm` and got the same menu.
 * It is a separate render path reached only by opening a post, so the list
 * test above says nothing about it — this is the reachability check for the
 * second caller.
 */
test("the thread view's delete affordance is the same menu and dialog", async ({
  page,
}) => {
  await openForum(page);

  const newestId = hexId(1000 + POST_COUNT - 1, "a");
  await page.getByTestId("forum-post-card").first().click();

  // The thread opened on the post that was clicked.
  await expect(page.getByText(`Post number ${POST_COUNT - 1}`)).toBeVisible();

  const trigger = page.getByTestId(`forum-message-menu-${newestId}`);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByTestId(`forum-message-menu-${newestId}-delete`).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Delete post?");
});
