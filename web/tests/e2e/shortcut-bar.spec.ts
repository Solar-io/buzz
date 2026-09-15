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
 * The per-channel shortcut bar, driven end to end against a faked relay.
 *
 * The mock (`helpers/mockRelay.ts`) is not a relay: it answers REQs from a
 * fixed set and acknowledges every publish without checking signatures. What
 * it CAN prove, and what a unit test cannot:
 *
 *  1. the decrypt path is real — the spec seeds a kind-30078 encrypted in
 *     Node with the SAME key the browser enrolls, and the pill that appears
 *     is the proof the client opened it;
 *  2. the publish path is real — the spec takes the event the client
 *     PUBLISHED, decrypts it with the same key, and asserts the exact JSON
 *     blob inside;
 *  3. the bar mounts under the real shell and its overlay really replaces
 *     the main pane (the "shipped and dead" check).
 *
 * What only live QA can prove is in the design doc (real relay fan-out,
 * second-tab sync, cleanup).
 */

const CHANNEL_ID = "5b1f2a34-1111-4222-8333-444455556666";
const PASSPHRASE = "e2e-passphrase";

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

test("a seeded encrypted blob renders as pills, window mode as a real link", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const secretKey = generateSecretKey();
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

  // The decrypt path: ciphertext in, labeled pill out.
  const overlayPill = page.getByTestId("shortcut-sc:1");
  await expect(overlayPill).toBeVisible();
  await expect(overlayPill).toContainText("kept");
  await expect(overlayPill).toHaveAttribute(
    "title",
    "https://kept.example/ — opens in the dock",
  );

  // Window mode is an anchor that opens a real tab, never an iframe.
  const windowPill = page.getByTestId("shortcut-sc:2");
  await expect(windowPill).toHaveAttribute("href", "https://docs.example/");
  await expect(windowPill).toHaveAttribute("target", "_blank");
  await expect(windowPill).toHaveAttribute("rel", /(^|\s)noopener(\s|$)/);

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

  await page.getByTestId("shortcut-bar-add").click();
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

  await page.getByTestId("shortcut-bar-add").click();
  await page.getByTestId("shortcut-url").fill("https://kept.example/");
  await page.getByTestId("shortcut-label").fill("kept");
  await page.getByTestId("shortcut-mode-overlay").check();
  await page.getByTestId("shortcut-submit").click();

  // Optimistic: the pill appears without waiting for a round trip (the mock
  // has no fan-out, so ONLY the optimistic path could have drawn it).
  const pill = page.getByTestId("shortcut-sc:1");
  await expect(pill).toBeVisible();

  // The publish is a real kind-30078 on the right coordinate...
  const published = relay.published.filter((event) => event.kind === 30078);
  expect(published.length).toBe(1);
  expect(published[0].tags).toContainEqual(["d", "shortcut-bar"]);

  // ...and the spec decrypts its content with the same key and asserts the
  // exact blob — the strongest claim available without a live relay.
  const key = nip44.v2.utils.getConversationKey(
    secretKey,
    getPublicKey(secretKey),
  );
  const decrypted = JSON.parse(nip44.v2.decrypt(published[0].content, key));
  expect(decrypted).toEqual({
    v: 1,
    shortcuts: {
      [CHANNEL_ID]: [
        {
          id: "sc:1",
          label: "kept",
          url: "https://kept.example/",
          mode: "overlay",
        },
      ],
    },
  });

  // The overlay: the clicked pill's site fills the main pane as a dock.
  await pill.click();
  const dock = page.getByTestId("web-panel-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId(`web-panel-tab-sc:1#1`)).toBeVisible();
  // No add/remove affordances: the shortcut dock's panels come from the bar.
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

  await page.getByTestId("shortcut-bar-add").click();
  await page.getByTestId("shortcut-url").fill("https://kept.example/");
  await page.getByTestId("shortcut-submit").click();
  await expect(page.getByTestId("shortcut-sc:1")).toBeVisible();

  // Adopt what the client published as stored relay state, then reload the
  // world: the pill that reappears comes from the relay-copy decrypt path,
  // not from any optimistic overlay (fresh page, fresh module store).
  const published = relay.published.filter((event) => event.kind === 30078);
  expect(published.length).toBe(1);
  relay.add(published[0]);
  await page.reload();
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();

  const pill = page.getByTestId("shortcut-sc:1");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("kept.example");
  expect(pageErrors).toEqual([]);
});
