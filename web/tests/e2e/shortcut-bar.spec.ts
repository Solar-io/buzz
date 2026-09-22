import { expect, type Page, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { nsecEncode } from "nostr-tools/nip19";

import {
  hexId,
  installMockRelay,
  mockEvent,
  type MockEvent,
} from "./helpers/mockRelay";

/**
 * The SIDEBAR shortcuts, driven end to end against a faked relay.
 *
 * These were per-channel pills in the channel header; they are now one
 * channel-independent list rendered as rows in a "Shortcuts" section below
 * Forums (the reserved `__sidebar__` key in the same encrypted blob). See
 * `features/shortcut-bar/lib/shortcutBlob.ts` for the shape and the seed.
 *
 * The mock (`helpers/mockRelay.ts`) is not a relay: it answers REQs from a
 * fixed set and acknowledges every publish without checking signatures. What
 * it CAN prove, and what a unit test cannot:
 *
 *  1. the decrypt path is real — the spec seeds a kind-30078 encrypted in
 *     Node with the SAME key the browser enrolls, and the row that appears
 *     is the proof the client opened it;
 *  2. the publish path is real — the spec takes the event the client
 *     PUBLISHED, decrypts it with the same key, and asserts the exact JSON
 *     blob inside;
 *  3. the section mounts under the real shell and its overlay really replaces
 *     the main pane (the "shipped and dead" check).
 *
 * What only live QA can prove is in the design doc (real relay fan-out,
 * second-tab sync, cleanup).
 */

const CHANNEL_ID = "5b1f2a34-1111-4222-8333-444455556666";
const PASSPHRASE = "e2e-passphrase";

/** The Shortcuts section's `+`, which is the header's add button. */
function addShortcutButton(page: Page) {
  return page.getByRole("button", { name: "Add a shortcut" });
}

/**
 * A shortcut row in the sidebar, found by its label.
 *
 * The rows carry no testid of their own (they are the same SidebarNavButton
 * a channel row uses), so this keys on the visible label and clicks the text,
 * which bubbles to the row button.
 */
function shortcutRow(page: Page, label: string) {
  return page.getByTestId("channel-sidebar").getByText(label, { exact: true });
}

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
  await page.getByPlaceholder("New passphrase").fill(PASSPHRASE);
  await page.getByPlaceholder("Confirm passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(
    page.getByRole("button", { name: "Enter key manually" }),
  ).toBeHidden();
}

/** The kind-39000 metadata that puts a permanent channel in the sidebar. */
function channelEvent(): MockEvent {
  return mockEvent({
    id: hexId(1),
    kind: 39000,
    created_at: 1_756_000_000,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "shortcut-e2e"],
    ],
  });
}

/** Seal `blob` to the owner's own pubkey, the same coordinate the app reads. */
function encryptBlob(secretKey: Uint8Array, blob: unknown): string {
  const key = nip44.v2.utils.getConversationKey(
    secretKey,
    getPublicKey(secretKey),
  );
  return nip44.v2.encrypt(JSON.stringify(blob), key);
}

/** The kind-30078 the app stores: one event per user, d="shortcut-bar". */
function shortcutBarEvent(
  secretKey: Uint8Array,
  blob: unknown,
  createdAt = 1_756_000_100,
): MockEvent {
  return mockEvent({
    id: hexId(2, "b"),
    pubkey: getPublicKey(secretKey),
    kind: 30078,
    created_at: createdAt,
    tags: [
      ["d", "shortcut-bar"],
      ["t", "shortcut-bar"],
    ],
    content: encryptBlob(secretKey, blob),
  });
}

test("a seeded blob written per-channel seeds the sidebar rows", async ({
  page,
  context,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const secretKey = generateSecretKey();
  // Deliberately the OLD shape: no `__sidebar__` key, both entries under the
  // channel. This is exactly what an existing user's blob looks like, so the
  // spec proves the seed migration against real decrypted ciphertext rather
  // than a hand-built union.
  await installMockRelay(page, [
    channelEvent(),
    shortcutBarEvent(secretKey, {
      v: 1,
      shortcuts: {
        [CHANNEL_ID]: [
          {
            id: "sc:1",
            label: "kept",
            url: "https://kept.example/",
            mode: "overlay",
          },
          {
            id: "sc:2",
            label: "docs",
            url: "https://docs.example/",
            mode: "window",
          },
        ],
      },
    }),
  ]);
  await signIn(page, `/repos?c=${CHANNEL_ID}`, secretKey);

  // The decrypt path: ciphertext in, a labeled row out — in the SIDEBAR, not
  // in any channel header.
  const sidebar = page.getByTestId("channel-sidebar");
  await expect(sidebar.getByText("Shortcuts")).toBeVisible();
  const overlayRow = shortcutRow(page, "kept");
  await expect(overlayRow).toBeVisible();
  await expect(shortcutRow(page, "docs")).toBeVisible();

  // Overlay mode opens the in-app dock, replacing the main pane.
  await overlayRow.click();
  await expect(page.getByTestId("web-panel-dock")).toBeVisible();
  await expect(page.getByTestId("web-panel-tab-sc:1#1")).toBeVisible();
  await page.getByTestId("web-panel-dock-close").click();

  // Window mode opens a real browser tab instead of the dock. The popup is
  // the assertion that separates "opened a tab" from "did nothing".
  //
  // `docs.example` is a documentation-reserved host with no server, and this
  // spec has no business reaching the internet, so the navigation is
  // fulfilled locally. The URL the browser lands on is still the shortcut's
  // own — which is the thing under test — and the stub keeps the spec
  // hermetic and free of DNS flake.
  await context.route("https://docs.example/**", (route) =>
    route.fulfill({ status: 200, body: "<!doctype html><title>docs</title>" }),
  );
  const popupPromise = context.waitForEvent("page");
  await shortcutRow(page, "docs").click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://docs.example/");
  await popup.close();

  expect(pageErrors).toEqual([]);
});

test("the add dialog refuses a hostile scheme with the allowlist error", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const secretKey = generateSecretKey();
  const relay = await installMockRelay(page, [channelEvent()]);
  await signIn(page, `/repos?c=${CHANNEL_ID}`, secretKey);

  await addShortcutButton(page).click();
  const dialog = page.getByTestId("shortcut-dialog");
  await expect(dialog).toBeVisible();

  // A javascript: URL that carries a real HOST — stopped only by the protocol
  // allowlist, not by the separate hostname check (the parity spec's reasoning).
  await page
    .getByTestId("shortcut-url")
    .fill("javascript://evil.example/%0aalert(1)");
  await page.getByTestId("shortcut-submit").click();
  await expect(page.getByTestId("shortcut-error")).toContainText(
    /http:\/\/ or https:\/\//,
  );
  await expect(dialog).toBeVisible();
  // The refusal is at the guard: nothing was encrypted, nothing published.
  // (Other kinds DO publish on connect — the presence beacon — so the claim
  // is scoped to the shortcut kind.)
  expect(relay.published.filter((event) => event.kind === 30078)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("adding an overlay shortcut publishes the exact encrypted blob and opens the dock", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const secretKey = generateSecretKey();
  const relay = await installMockRelay(page, [channelEvent()]);
  await signIn(page, `/repos?c=${CHANNEL_ID}`, secretKey);

  // Wait for the authenticated socket BEFORE adding.
  //
  // The `+` used to live in the channel header, which only exists once a
  // channel is open — i.e. after the session connected. It is now in the
  // sidebar, which renders immediately, so a spec can add while the socket is
  // still authenticating. `session.publish` PARKS an event until the
  // authenticated flush (relay-session.ts, D-042), so the write still lands —
  // just later, and `relay.published` is empty in the meantime. Waiting here
  // makes the assertion below about the write, not about connection timing.
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await expect
    .poll(() => relay.published.length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  await addShortcutButton(page).click();
  await page.getByTestId("shortcut-url").fill("https://kept.example/");
  await page.getByTestId("shortcut-label").fill("kept");
  await page.getByTestId("shortcut-mode-overlay").check();
  await page.getByTestId("shortcut-submit").click();

  // Optimistic: the row appears without waiting for a round trip (the mock
  // has no fan-out, so ONLY the optimistic path could have drawn it).
  await expect(shortcutRow(page, "kept")).toBeVisible();

  // The publish is a real kind-30078 on the right coordinate...
  await expect
    .poll(
      () => relay.published.filter((event) => event.kind === 30078).length,
      { timeout: 10_000 },
    )
    .toBe(1);
  const published = relay.published.filter((event) => event.kind === 30078);
  expect(published[0].tags).toContainEqual(["d", "shortcut-bar"]);

  // ...and the spec decrypts its content with the same key and asserts the
  // exact blob — the strongest claim available without a live relay.
  //
  // It lands under the RESERVED key, not the open channel's id. That is the
  // whole change: a shortcut is no longer tied to a channel, and a blob
  // written here must not put anything under CHANNEL_ID.
  const key = nip44.v2.utils.getConversationKey(
    secretKey,
    getPublicKey(secretKey),
  );
  const decrypted = JSON.parse(nip44.v2.decrypt(published[0].content, key));
  expect(decrypted).toEqual({
    v: 1,
    shortcuts: {
      __sidebar__: [
        {
          id: "sc:1",
          label: "kept",
          url: "https://kept.example/",
          mode: "overlay",
        },
      ],
    },
  });

  // The overlay: the clicked row's site fills the main pane as a dock.
  await shortcutRow(page, "kept").click();
  const dock = page.getByTestId("web-panel-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId(`web-panel-tab-sc:1#1`)).toBeVisible();
  // No add/remove affordances: the shortcut dock's panels come from the list.
  await expect(page.getByTestId("web-panel-add-site")).toHaveCount(0);
  await expect(page.getByTestId("web-panel-remove-sc:1")).toHaveCount(0);

  // X returns to the conversation.
  await page.getByTestId("web-panel-dock-close").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("a published event re-read on a fresh sign-in renders without optimism", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const secretKey = generateSecretKey();
  const relay = await installMockRelay(page, [channelEvent()]);
  await signIn(page, `/repos?c=${CHANNEL_ID}`, secretKey);

  // Connected first, for the same reason as the spec above: the sidebar's `+`
  // is reachable before the socket authenticates, and a publish made in that
  // window is parked until the flush rather than dropped.
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await expect
    .poll(() => relay.published.length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  await addShortcutButton(page).click();
  await page.getByTestId("shortcut-url").fill("https://kept.example/");
  await page.getByTestId("shortcut-submit").click();
  await expect(shortcutRow(page, "kept.example")).toBeVisible();

  // Adopt what the client published as stored relay state, then reload the
  // world: the row that reappears comes from the relay-copy decrypt path,
  // not from any optimistic overlay (fresh page, fresh module store).
  await expect
    .poll(
      () => relay.published.filter((event) => event.kind === 30078).length,
      { timeout: 10_000 },
    )
    .toBe(1);
  const published = relay.published.filter((event) => event.kind === 30078);
  relay.add(published[0]);
  await page.reload();
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();

  await expect(shortcutRow(page, "kept.example")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
