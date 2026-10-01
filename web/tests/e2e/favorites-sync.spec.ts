import { expect, test } from "@playwright/test";
import * as nip44 from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";

import { hexId, mockEvent, type MockEvent } from "./helpers/mockRelay";
import { openShell } from "./helpers/shellPage";
import { buildWorkFixture } from "./helpers/workFixture";

/**
 * Sidebar favorites sync per user through the relay (kind 30078,
 * `d=sidebar-favorites`, NIP-44 sealed to self) — the reachability half of
 * `favoritesSync.test.mjs`: the event must actually be REQ'd, decrypted and
 * rendered on a fresh phone, and a device with its own favorites must
 * publish the union rather than lose them.
 */

const D_TAG = "sidebar-favorites";

function favoritesEvent(
  secretKey: Uint8Array,
  favorites: Array<{ kind: "channel" | "link"; id: string; at: number }>,
  removed: Array<{ kind: "channel" | "link"; id: string; at: number }> = [],
): MockEvent {
  const pubkey = getPublicKey(secretKey);
  return mockEvent({
    id: hexId(903, "f"),
    pubkey,
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000) - 3_600,
    tags: [
      ["d", D_TAG],
      ["t", D_TAG],
    ],
    content: nip44.v2.encrypt(
      JSON.stringify({ v: 1, favorites, removed }),
      nip44.v2.utils.getConversationKey(secretKey, pubkey),
    ),
  });
}

function open(secretKey: Uint8Array, event: MockEvent): MockEvent {
  return JSON.parse(
    nip44.v2.decrypt(
      event.content,
      nip44.v2.utils.getConversationKey(secretKey, getPublicKey(secretKey)),
    ),
  );
}

test.describe("favorites sync · phone 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a fresh device shows the relay's favorites and lands on Channels", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const { relay } = await openShell(page, {
      theme: "buzz",
      path: () => "/repos",
      extra: (fixture) => [
        favoritesEvent(
          fixture.viewerKey,
          [
            { kind: "channel", id: fixture.channels.design, at: 1_000 },
            { kind: "channel", id: fixture.channels["dm-gilfoyle"], at: 2_000 },
          ],
          [{ kind: "channel", id: fixture.channels["flight-path"], at: 3_000 }],
        ),
      ],
    });

    // No `?view=`, nothing remembered: the phone opens on Channels.
    await expect(page).toHaveURL(/view=channels/);
    const tabs = page.getByTestId("phone-tab-bar");
    await expect(
      tabs.getByRole("button", { name: /Channels/ }),
    ).toHaveAttribute("aria-current", "page");

    const rail = page.getByTestId("channel-sidebar").filter({ visible: true });
    const favorites = rail.locator('section[aria-label="Favorites"]');
    await expect(favorites).toBeVisible();
    await expect(favorites).toContainText("design");
    await expect(favorites).toContainText("Gilfoyle");
    await expect(favorites).not.toContainText("flight-path");
    // The relay copy lands in this device's offline cache, in its order.
    const cached = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("buzz.channel-prefs.v1") ?? "{}"),
    );
    expect(cached.favorites.map((f: { id: string }) => f.id)).toHaveLength(2);
    // Already in sync: this device has nothing to publish.
    expect(
      relay.published.filter((event) =>
        event.tags.some((tag) => tag[0] === "d" && tag[1] === D_TAG),
      ),
    ).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });

  test("a device with its own favorites keeps them and publishes the union", async ({
    page,
  }) => {
    // This device already favorited flight-path, before sync existed (no
    // stamp) — the shape every current install has. Seeded once only, so a
    // navigation cannot re-plant it over the merge.
    const ids = buildWorkFixture().channels;
    await page.addInitScript((id) => {
      try {
        if (localStorage.getItem("buzz.channel-prefs.v1") === null) {
          localStorage.setItem(
            "buzz.channel-prefs.v1",
            JSON.stringify({ favorites: [{ kind: "channel", id }], muted: [] }),
          );
        }
      } catch {
        // A sandboxed frame: nothing to seed.
      }
    }, ids["flight-path"]);
    const { fixture, relay } = await openShell(page, {
      theme: "buzz",
      path: () => "/repos?view=channels",
      extra: (fixture) => [
        favoritesEvent(fixture.viewerKey, [
          { kind: "channel", id: fixture.channels.design, at: 1_000 },
        ]),
      ],
      relay: { onPublish: (event, mock) => mock.push(event) },
    });

    const rail = page.getByTestId("channel-sidebar").filter({ visible: true });
    const favorites = rail.locator('section[aria-label="Favorites"]');
    await expect(favorites).toContainText("design");
    await expect(favorites).toContainText("flight-path");

    await expect
      .poll(
        () =>
          relay.published.filter((event) =>
            event.tags.some((tag) => tag[0] === "d" && tag[1] === D_TAG),
          ).length,
      )
      .toBeGreaterThan(0);
    const sent = relay.published.filter((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] === D_TAG),
    );
    const blob = open(fixture.viewerKey, sent[sent.length - 1]) as unknown as {
      favorites: Array<{ id: string }>;
    };
    expect(blob.favorites.map((f) => f.id)).toEqual([
      fixture.channels.design,
      fixture.channels["flight-path"],
    ]);
  });
});
