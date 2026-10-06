import {
  type Browser,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { test } from "./helpers/agentBraveTest";
import { installHatchMock } from "./helpers/hatchMock";
import {
  hexId,
  installMockRelay,
  type MockEvent,
  type MockRelay,
  type MockRelayOptions,
  mockEvent,
} from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";
import { routeUsageHub } from "./helpers/workFixture";

/**
 * Live unread, end to end (LEFT_NAV_ARCHITECTURE_REVIEW.md phase 3): the
 * built bundle, a relay faked at the socket, and the mouse RESTING ON THE
 * SIDEBAR — the case sidebar-order.spec.ts deliberately avoids by moving the
 * mouse away, and the one Sam hit: a toast arrived and the DM row showed
 * nothing. 20 DMs, so truncation is in play; every DM starts read.
 */

const DM_COUNT = 20;
/** A–Z slot 16: behind "N more" until it turns unread. */
const TARGET = 15;

const peerName = (i: number) => `Peer ${String(i).padStart(2, "0")}`;
const dmId = (i: number) =>
  `d0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
const GENERAL = "c0000000-0000-4000-8000-000000000001";

interface Fixture {
  viewerKey: Uint8Array;
  viewer: string;
  peers: string[];
  events: MockEvent[];
  read: Record<string, number>;
  nowS: number;
}

function buildFixture(): Fixture {
  const viewerKey = generateSecretKey();
  const viewer = getPublicKey(viewerKey);
  const nowS = Math.floor(Date.now() / 1_000);
  const read: Record<string, number> = {};
  const peers: string[] = [];
  let seq = 1;
  const events: MockEvent[] = [
    mockEvent({
      id: hexId(seq++),
      kind: 0,
      pubkey: viewer,
      content: JSON.stringify({ display_name: "Unread tester" }),
    }),
    mockEvent({
      id: hexId(seq++),
      kind: 39000,
      created_at: nowS - 86_400,
      tags: [
        ["d", GENERAL],
        ["name", "general"],
        ["t", "stream"],
      ],
    }),
    mockEvent({
      id: hexId(seq++),
      kind: 9,
      pubkey: viewer,
      created_at: nowS - 5_000,
      tags: [["h", GENERAL]],
      content: "the channel the viewer is reading",
    }),
  ];
  read[GENERAL] = nowS - 5_000;
  for (let i = 0; i < DM_COUNT; i += 1) {
    const peer = getPublicKey(generateSecretKey());
    peers.push(peer);
    const at = nowS - 3_000 - i;
    events.push(
      mockEvent({
        id: hexId(seq++),
        kind: 39000,
        created_at: nowS - 86_400,
        tags: [
          ["d", dmId(i)],
          ["name", `raw-dm-${i}`],
          ["t", "dm"],
          ["p", viewer],
          ["p", peer],
        ],
      }),
      mockEvent({
        id: hexId(seq++),
        kind: 0,
        pubkey: peer,
        content: JSON.stringify({ display_name: peerName(i) }),
      }),
      mockEvent({
        id: hexId(seq++),
        kind: 9,
        pubkey: peer,
        created_at: at,
        tags: [["h", dmId(i)]],
        content: `Earlier in ${peerName(i)}`,
      }),
    );
    // Read exactly up to the newest message: nothing unread at boot.
    read[dmId(i)] = at;
  }
  return { viewerKey, viewer, peers, events, read, nowS };
}

async function openApp(
  page: Page,
  fixture: Fixture,
  path: string,
  relayOptions: MockRelayOptions = {},
): Promise<MockRelay> {
  await page.addInitScript(
    ({ read }) => {
      try {
        localStorage.setItem("buzz.read-state.v1", JSON.stringify(read));
        localStorage.setItem("buzz.collapsed-sections.v1", "[]");
        localStorage.setItem("buzz-theme", "buzz");
        localStorage.setItem("buzz-follow-system", "false");
      } catch {
        // Sandboxed frames have no localStorage.
      }
    },
    { read: fixture.read },
  );
  await routeUsageHub(page);
  await installHatchMock(page);
  const relay = await installMockRelay(page, fixture.events, relayOptions);
  await signIn(page, path, fixture.viewerKey);
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  return relay;
}

function dmSection(page: Page): Locator {
  return page
    .getByTestId("channel-sidebar")
    .locator('section[aria-label="Direct messages"]');
}

function dmRow(page: Page, name: string): Locator {
  return dmSection(page)
    .locator("ul > li > button[data-active]")
    .filter({ has: page.locator("span.truncate", { hasText: name }) });
}

function liveDm(fixture: Fixture, i: number, id: string, ageS = 0): MockEvent {
  return mockEvent({
    id,
    kind: 9,
    pubkey: fixture.peers[i] as string,
    created_at: Math.floor(Date.now() / 1_000) - ageS,
    tags: [["h", dmId(i)]],
    content: `Live message ${id.slice(-4)}`,
  });
}

/** Make the page look exactly like a hidden, unfocused tab (or undo it). */
async function setAttention(page: Page, attended: boolean): Promise<void> {
  await page.evaluate((on) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (on ? "visible" : "hidden"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => !on,
    });
    document.hasFocus = () => on;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(on ? "focus" : "blur"));
  }, attended);
}

test.use({ viewport: { width: 1_440, height: 1_000 } });

test("a live DM under a resting pointer: toast AND row pill 1, then 2, and opening the DM clears it", async ({
  page,
}) => {
  const fixture = buildFixture();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const relay = await openApp(page, fixture, `/repos?c=${GENERAL}`);

  await expect(dmSection(page).getByTestId("section-more")).toHaveText(
    `${DM_COUNT - 6} more`,
  );
  await expect(dmRow(page, peerName(TARGET))).toHaveCount(0);

  // The mouse rests on the third DM row and stays there.
  const resting = dmSection(page)
    .locator("ul > li > button[data-active]")
    .nth(2);
  await resting.hover();
  const restingName = await resting.locator("span.truncate").textContent();

  relay.push(liveDm(fixture, TARGET, hexId(9_001, "e")));
  await expect(page.getByTestId("buzz-toast-message").first()).toBeVisible();
  const row = dmRow(page, peerName(TARGET));
  await expect(row.getByTestId("dm-row-badge")).toHaveText("1");
  // The row under the pointer did not move.
  await expect(
    dmSection(page).locator("ul > li > button[data-active]").nth(2),
  ).toContainText(restingName ?? "");

  relay.push(liveDm(fixture, TARGET, hexId(9_002, "e")));
  await expect(row.getByTestId("dm-row-badge")).toHaveText("2");

  await row.click();
  await page.mouse.move(1_000, 100);
  await expect(
    dmRow(page, peerName(TARGET)).getByTestId("dm-row-badge"),
  ).toHaveCount(0);
  // The prod bundle carries the unread trace, naming who moved the marker.
  const lastMove = await page.evaluate(() => {
    const trail = (
      window as unknown as {
        __buzzUnreadTrace: Array<{ type: string; id: string; source?: string }>;
      }
    ).__buzzUnreadTrace;
    return trail.filter((entry) => entry.type === "markerMoved").at(-1);
  });
  expect(lastMove).toMatchObject({ id: dmId(TARGET), source: "open" });
  expect(errors).toEqual([]);
});

async function twoDevices(browser: Browser, fixture: Fixture) {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  // One relay, played by two mocks: whatever read state either device
  // publishes (kind 30078, NIP-RS) reaches the other's open subscription.
  const relays: { a?: MockRelay; b?: MockRelay } = {};
  const relayA = await openApp(pageA, fixture, `/repos?c=${GENERAL}`, {
    onPublish: (event) => {
      if (event.kind === 30078) relays.b?.push(event);
    },
  });
  relays.a = relayA;
  const relayB = await openApp(pageB, fixture, `/repos?c=${dmId(TARGET)}`, {
    onPublish: (event) => {
      if (event.kind === 30078) relays.a?.push(event);
    },
  });
  relays.b = relayB;
  return { contextA, contextB, pageA, pageB, relayA, relayB };
}

test("two devices: B has the DM open but HIDDEN, so A keeps its pill; once B is looked at, NIP-RS clears A", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fixture = buildFixture();
  const { contextA, contextB, pageA, pageB, relayA, relayB } = await twoDevices(
    browser,
    fixture,
  );
  try {
    await expect(
      pageB.getByText(`Earlier in ${peerName(TARGET)}`),
    ).toBeVisible();
    // B's own boot publishes (the NIP-RS seed) are done before we start.
    await pageB.waitForTimeout(1_000);
    await setAttention(pageB, false);
    const readStateBefore = relayB.published.filter(
      (e) => e.kind === 30078,
    ).length;

    const message = liveDm(fixture, TARGET, hexId(9_101, "e"));
    relayA.push(message);
    relayB.push(message);
    // B's timeline shows it (the conversation IS open there)...
    await expect(pageB.getByText(message.content)).toBeVisible();
    // ...and A shows the pill.
    const rowA = dmRow(pageA, peerName(TARGET));
    await expect(rowA.getByTestId("dm-row-badge")).toHaveText("1");

    // Past B's 5 s NIP-RS debounce with margin: an unattended B must not
    // have marked it read, so nothing reached A and the pill stays.
    await pageA.waitForTimeout(8_000);
    await expect(rowA.getByTestId("dm-row-badge")).toHaveText("1");
    expect(
      relayB.published.filter((e) => e.kind === 30078).length,
      "hidden B published no read state",
    ).toBe(readStateBefore);

    // Control: the same path DOES clear A once B is actually looked at, so
    // the wait above could have failed.
    await setAttention(pageB, true);
    await expect(rowA.getByTestId("dm-row-badge")).toHaveCount(0, {
      timeout: 15_000,
    });
    const clear = await pageA.evaluate(
      (id) =>
        (
          window as unknown as {
            __buzzUnreadTrace: Array<{
              type: string;
              id: string;
              source?: string;
            }>;
          }
        ).__buzzUnreadTrace
          .filter((entry) => entry.type === "markerMoved" && entry.id === id)
          .at(-1),
      dmId(TARGET),
    );
    expect(clear?.source ?? "").toMatch(/^sync:/);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
