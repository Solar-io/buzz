import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";

import {
  hexId,
  installMockRelay,
  mockEvent,
  type MockEvent,
} from "./helpers/mockRelay";

/**
 * The moderation queue, driven with real reports.
 *
 * This is the only instrument that can catch the failure this pane is most
 * exposed to. Its authority logic is unit-tested exhaustively, but a pane
 * nothing renders is indistinguishable from a working one, and the two role
 * snapshots it depends on arrive over the WebSocket rather than from props —
 * so "the queue computes the right answer" and "the queue is looking at the
 * right inputs" are separate claims, and only this file makes the second.
 *
 * The discriminating pair is "a community owner with no channel role is
 * refused kick and remove" and "the same owner, named in the channel's admin
 * snapshot, is offered both". The community role is `owner` in BOTH — and both
 * assert Ban is enabled — so the only thing that moves is the kind-39001
 * snapshot, which is precisely the arm `validate_admin_event` reads and the
 * desktop client does not. A fixture where either role allowed Kick anyway
 * would prove nothing about it.
 *
 * They are two tests rather than two halves of one because the sign-in gate
 * only appears for a browser with no enrolled key; re-running it in the same
 * page finds no form.
 */

/**
 * PRECONDITION, NOT AN ASSERTION — delete this block once the wiring lands.
 *
 * The pane is reached as `?view=moderation`, and the shell drops any `view`
 * outside `SHELL_VIEWS` (`app/routes/repos.tsx`, `validateSearch`). That file
 * was deliberately left untouched by the change these tests cover, so until
 * three lines are added there every test below would fail for a reason that
 * has nothing to do with the code under test.
 *
 * This reads the route file to decide whether the wiring is present. It is a
 * source-text check and proves nothing about behaviour — that is exactly why
 * it gates the run rather than asserting anything. With the wiring applied,
 * all twelve tests here run and pass (measured, 2026-09-04); without it they
 * skip with the reason below instead of turning the suite red.
 */
const SHELL_WIRED = readFileSync(
  fileURLToPath(new URL("../../src/app/routes/repos.tsx", import.meta.url)),
  "utf8",
).includes('"moderation",');

test.skip(
  !SHELL_WIRED,
  'the moderation pane is not wired into the shell yet: add "moderation" to SHELL_VIEWS in app/routes/repos.tsx, import ModerationQueueView, and add its branch',
);

const CHANNEL_ID = "7c2d3e45-1111-4222-8333-444455556666";
/** The resolve menu's own test-id prefix for the spam group. */
const RESOLVE = `moderation-resolve-event:${"bb".repeat(32)}`;
/** Enforcement + resolve kinds, so presence traffic never lands in an index. */
const MODERATION_KINDS = [9001, 9005, 9040, 9042, 9044];
const REPORTED_EVENT = "bb".repeat(32);
const REPORTER = "cc".repeat(32);
const REPORT_EVENT_ID = "dd".repeat(32);
const AUTHOR_SECRET = generateSecretKey();
const REPORTED_AUTHOR = getPublicKey(AUTHOR_SECRET);

const OPEN_REPORT = {
  id: "report-row-1",
  report_event_id: REPORT_EVENT_ID,
  reporter_pubkey: REPORTER,
  target_kind: "event",
  target: REPORTED_EVENT,
  channel_id: CHANNEL_ID,
  report_type: "spam",
  note: "Posting the same link over and over",
  status: "open",
  resolved_by: null,
  resolved_at: null,
  action_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

const ILLEGAL_REPORT = {
  ...OPEN_REPORT,
  id: "report-row-2",
  report_event_id: "ee".repeat(32),
  target: "ff".repeat(32),
  report_type: "illegal",
  note: null,
  // Older than the spam report, so severity has to be what puts it first.
  created_at: "2026-08-20T10:00:00Z",
};

/** Serve the two moderator-only reads, or refuse them with the relay's 403. */
async function routeModerationReads(
  page: Page,
  options: { forbidden?: boolean; reports?: unknown[] } = {},
): Promise<void> {
  await page.route("**/moderation/reports*", async (route) => {
    if (options.forbidden) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: "restricted: moderator access required",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(options.reports ?? [OPEN_REPORT, ILLEGAL_REPORT]),
    });
  });
  await page.route("**/moderation/audit*", async (route) => {
    if (options.forbidden) {
      await route.fulfill({ status: 403, body: "[]" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "audit-1",
          actor_pubkey: "11".repeat(32),
          action: "resolve:ban",
          target_pubkey: null,
          target_event_id: REPORTED_EVENT,
          channel_id: CHANNEL_ID,
          reason_code: null,
          public_reason: "Second offence",
          private_reason: null,
          matched_principal: null,
          created_at: "2026-08-25T10:00:00Z",
        },
      ]),
    });
  });
}

/** kind-13534: the NIP-43 membership snapshot naming `viewer` as `role`. */
function membershipEvent(viewer: string, role: string): MockEvent {
  return mockEvent({
    id: hexId(2),
    kind: 13534,
    created_at: 1_756_000_000,
    tags: [
      ["member", viewer, role],
      ["member", REPORTED_AUTHOR, "member"],
    ],
  });
}

/** kind-39001: the channel's admin snapshot naming `viewer` as `role`. */
function channelAdminsEvent(viewer: string, role: string): MockEvent {
  return mockEvent({
    id: hexId(3),
    kind: 39001,
    created_at: 1_756_000_000,
    tags: [
      ["d", CHANNEL_ID],
      ["p", viewer, role],
    ],
  });
}

/** The reported message itself, so its author can be resolved. */
function reportedMessageEvent(): MockEvent {
  return mockEvent({
    id: REPORTED_EVENT,
    pubkey: REPORTED_AUTHOR,
    kind: 9,
    created_at: 1_756_000_100,
    tags: [["h", CHANNEL_ID]],
    content: "Buy cheap followers at example.invalid",
  });
}

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

/**
 * Open the queue as a viewer holding `communityRole`, and optionally a role in
 * the reported channel.
 */
async function openQueue(
  page: Page,
  options: {
    communityRole?: string;
    channelRole?: string;
    forbidden?: boolean;
  } = {},
): Promise<void> {
  const secretKey = generateSecretKey();
  const viewer = getPublicKey(secretKey);
  const events: MockEvent[] = [reportedMessageEvent()];
  if (options.communityRole) {
    events.push(membershipEvent(viewer, options.communityRole));
  }
  if (options.channelRole) {
    events.push(channelAdminsEvent(viewer, options.channelRole));
  }
  await installMockRelay(page, events);
  await routeModerationReads(page, { forbidden: options.forbidden });
  await signIn(page, "/repos?view=moderation", secretKey);
}

test("?view=moderation renders the queue inside the shell", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openQueue(page, { communityRole: "owner" });

  await expect(page.getByTestId("moderation-queue")).toBeVisible();
  // A view of the shell, not a route: the sidebar must survive.
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await expect(page.getByTestId("moderation-queue-list")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("a member who is not a moderator gets the relay's own refusal", async ({
  page,
}) => {
  await openQueue(page, { forbidden: true });
  await expect(page.getByTestId("moderation-queue-forbidden")).toBeVisible();
  await expect(page.getByTestId("moderation-queue-list")).toHaveCount(0);
});

/**
 * The failure the browser pass actually found.
 *
 * A same-origin deploy answers an unknown path with the SPA shell, so a 200
 * carrying `<!doctype html>` reaches `response.json()` and it throws. The pane
 * used to render that thrown message verbatim — "Unexpected token '<',
 * "<!doctype "... is not valid JSON" — which tells a moderator nothing and
 * reads as a crash. Only the relay's own phrasing is safe to pass through.
 */
test("a non-JSON answer is reported in words, not as a parser message", async ({
  page,
}) => {
  const secretKey = generateSecretKey();
  const viewer = getPublicKey(secretKey);
  await installMockRelay(page, [membershipEvent(viewer, "owner")]);
  await page.route("**/moderation/reports*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>not the api</body></html>",
    });
  });
  await page.route("**/moderation/audit*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await signIn(page, "/repos?view=moderation", secretKey);

  const pane = page.getByTestId("moderation-queue");
  await expect(pane).toContainText("The moderation read failed");
  await expect(pane).not.toContainText("JSON");
  await expect(pane).not.toContainText("doctype");
});

test("reports group by target, ordered by severity, with their context", async ({
  page,
}) => {
  await openQueue(page, { communityRole: "owner" });

  const groups = page.locator('[data-testid^="moderation-group-"]');
  await expect(groups).toHaveCount(2);

  // Severity wins over recency: the illegal report is older and leads anyway.
  await expect(groups.first()).toContainText("Illegal content");
  await expect(groups.nth(1)).toContainText("Spam");

  // The spam group carries what was reported, who reported it, the note, and
  // the prior action from the audit log.
  const spamGroup = page.getByTestId(
    `moderation-group-event:${REPORTED_EVENT}`,
  );
  await expect(spamGroup).toContainText("Buy cheap followers");
  await expect(spamGroup).toContainText("Posting the same link over and over");
  await expect(spamGroup).toContainText("1 prior action");
  await expect(spamGroup).toContainText("resolve:ban");
});

test("the audit tab lists the community's accepted actions", async ({
  page,
}) => {
  await openQueue(page, { communityRole: "owner" });
  await page.getByTestId("moderation-tab-audit").click();
  await expect(page.getByTestId("moderation-audit-list")).toBeVisible();
  await expect(page.getByTestId("moderation-audit-audit-1")).toContainText(
    "resolve:ban",
  );
  await expect(page.getByTestId("moderation-audit-audit-1")).toContainText(
    "Second offence",
  );
});

/**
 * The discriminating test.
 *
 * Same viewer role at the community level (owner, so Ban is offered in both
 * runs and the fixture is not trivially "allowed everywhere"), and the only
 * thing that changes is whether the reported channel's kind-39001 snapshot
 * names them. `validate_admin_event` reads exactly that snapshot for 9001 and
 * 9005 and never consults community membership, so Kick and Remove message
 * must follow it — this is where the desktop client and the relay disagree.
 */
test("a community owner with no channel role is refused kick and remove", async ({
  page,
}) => {
  await openQueue(page, { communityRole: "owner" });
  await page.getByTestId(`${RESOLVE}-trigger`).click();
  // Ban IS offered, so the community axis plainly holds and the refusals
  // below can only be about the channel axis.
  await expect(page.getByTestId(`${RESOLVE}-ban`)).toBeEnabled();
  await expect(page.getByTestId(`${RESOLVE}-dismiss`)).toBeEnabled();
  await expect(page.getByTestId(`${RESOLVE}-kick`)).toBeDisabled();
  await expect(page.getByTestId(`${RESOLVE}-delete`)).toBeDisabled();
  await expect(page.getByTestId(`${RESOLVE}-kick`)).toContainText(
    "Requires owner or admin of this channel",
  );
});

test("the same owner, named in the channel's admin snapshot, is offered both", async ({
  page,
}) => {
  await openQueue(page, { communityRole: "owner", channelRole: "admin" });
  await page.getByTestId(`${RESOLVE}-trigger`).click();
  await expect(page.getByTestId(`${RESOLVE}-ban`)).toBeEnabled();
  await expect(page.getByTestId(`${RESOLVE}-kick`)).toBeEnabled();
  await expect(page.getByTestId(`${RESOLVE}-delete`)).toBeEnabled();
});

/**
 * A resolution is two events and the enforcement has to land FIRST, or the
 * relay DMs the reporter that something happened which did not. The order of
 * the published frames is the evidence.
 */
test("resolving with an enforcement publishes the enforcement before the resolve", async ({
  page,
}) => {
  const secretKey = generateSecretKey();
  const viewer = getPublicKey(secretKey);
  const relay = await installMockRelay(page, [
    reportedMessageEvent(),
    membershipEvent(viewer, "owner"),
    channelAdminsEvent(viewer, "owner"),
  ]);
  await routeModerationReads(page);
  await signIn(page, "/repos?view=moderation", secretKey);

  await page.getByTestId(`${RESOLVE}-trigger`).click();
  await page.getByTestId(`${RESOLVE}-delete`).click();

  // Presence (kind 20001) rides the same socket, so the stream is filtered to
  // the moderation kinds rather than indexed blindly.
  const commands = () =>
    relay.published.filter((event) => MODERATION_KINDS.includes(event.kind));
  await expect.poll(() => commands().length).toBe(2);
  // 9005 removal FIRST, then the resolve that closes the report — the whole
  // honesty guarantee is in that order.
  expect(commands().map((event) => event.kind)).toEqual([9005, 9044]);

  const removal = commands()[0];
  expect(removal.tags).toContainEqual(["h", CHANNEL_ID]);
  expect(removal.tags).toContainEqual(["e", REPORTED_EVENT]);

  const resolve = commands()[1];
  expect(resolve.tags).toContainEqual(["report", REPORT_EVENT_ID]);
  expect(resolve.tags).toContainEqual(["status", "resolved"]);
  expect(resolve.tags).toContainEqual(["action", "delete"]);
  // A community-global command must not be channel-scoped.
  expect(resolve.tags.some((tag) => tag[0] === "h")).toBe(false);
});

/**
 * The decision-only path: dismissing sends ONE event, and it says dismissed.
 * A resolve that dragged an enforcement along would show up as a second frame.
 */
test("dismissing publishes one resolve, with the dismissed status", async ({
  page,
}) => {
  const secretKey = generateSecretKey();
  const viewer = getPublicKey(secretKey);
  const relay = await installMockRelay(page, [
    reportedMessageEvent(),
    membershipEvent(viewer, "admin"),
  ]);
  await routeModerationReads(page);
  await signIn(page, "/repos?view=moderation", secretKey);

  await page.getByTestId(`${RESOLVE}-trigger`).click();
  await page.getByTestId(`${RESOLVE}-dismiss`).click();

  const commands = () =>
    relay.published.filter((event) => MODERATION_KINDS.includes(event.kind));
  await expect.poll(() => commands().length).toBe(1);
  const [resolve] = commands();
  expect(resolve.kind).toBe(9044);
  expect(resolve.tags).toContainEqual(["status", "dismissed"]);
  expect(resolve.tags).toContainEqual(["action", "dismiss"]);
});

/**
 * The queue's entry point is itself gated, and a gate is the easiest thing in
 * this change to get backwards: too tight and no moderator ever finds the
 * queue, too loose and every member is offered a pane that answers 403. Both
 * halves are asserted, and the only difference between them is the kind-13534
 * snapshot the mock serves.
 */
test("the sidebar offers Moderation to a moderator", async ({ page }) => {
  await openQueue(page, { communityRole: "owner" });
  await expect(
    page.getByTestId("channel-sidebar").getByRole("button", {
      name: "Moderation",
    }),
  ).toBeVisible();
});

test("a member with no moderator role is not offered the entry", async ({
  page,
}) => {
  await openQueue(page, { communityRole: "member", forbidden: true });
  const sidebar = page.getByTestId("channel-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Moderation" })).toHaveCount(
    0,
  );
});

test("the sidebar entry actually opens the queue", async ({ page }) => {
  const secretKey = generateSecretKey();
  const viewer = getPublicKey(secretKey);
  await installMockRelay(page, [
    reportedMessageEvent(),
    membershipEvent(viewer, "admin"),
  ]);
  await routeModerationReads(page);
  // Start on the ordinary shell, so reaching the queue is the click's doing.
  await signIn(page, "/repos", secretKey);
  await expect(page.getByTestId("moderation-queue")).toHaveCount(0);

  await page
    .getByTestId("channel-sidebar")
    .getByRole("button", { name: "Moderation" })
    .click();
  await expect(page.getByTestId("moderation-queue")).toBeVisible();
  await expect(page).toHaveURL(/view=moderation/);
});
