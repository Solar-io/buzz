import { expect, type Locator, type Page } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { test } from "./helpers/agentBraveTest";
import { installHatchMock } from "./helpers/hatchMock";
import {
  hexId,
  installMockRelay,
  type MockEvent,
  type MockRelay,
  mockEvent,
} from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";
import { routeUsageHub } from "./helpers/workFixture";

/**
 * LEFT_NAV_ARCHITECTURE_REVIEW.md section 5 scenario matrix, QA pass.
 * 24 DMs (truncation in play); every DM starts read unless a scenario says
 * otherwise. Each scenario runs with the pointer RESTING on the DM list and
 * AWAY from it.
 */

const DM_COUNT = 24;
const TARGET = 18; // A-Z slot 19: behind "N more"
const GENERAL = "c0000000-0000-4000-8000-000000000001";
const RANDOM = "c0000000-0000-4000-8000-000000000002";
const FORUM = "c0000000-0000-4000-8000-000000000003";
const peerName = (i: number) => `Peer ${String(i).padStart(2, "0")}`;
const dmId = (i: number) =>
  `d0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
let uid = 100;
const nextId = () => hexId(++uid, "e");

interface Opts {
  muted?: number[];
  favorites?: number[];
  collapsed?: string[];
  /** DM index -> number of unread messages at boot. */
  unreadAtBoot?: Record<number, number>;
  dmCount?: number;
  history?: number;
  notifications?: boolean;
}

function build(opts: Opts = {}) {
  const viewerKey = generateSecretKey();
  const viewer = getPublicKey(viewerKey);
  const nowS = Math.floor(Date.now() / 1_000);
  const n = opts.dmCount ?? DM_COUNT;
  const read: Record<string, number> = {};
  const peers: string[] = [];
  let seq = 1;
  const ev: MockEvent[] = [
    mockEvent({
      id: hexId(seq++),
      kind: 0,
      pubkey: viewer,
      content: JSON.stringify({ display_name: "Tester" }),
    }),
  ];
  for (const [id, name, t] of [
    [GENERAL, "general", "stream"],
    [RANDOM, "random", "stream"],
    [FORUM, "forum-one", "forum"],
  ]) {
    ev.push(
      mockEvent({
        id: hexId(seq++),
        kind: 39000,
        created_at: nowS - 86_400,
        tags: [
          ["d", id as string],
          ["name", name as string],
          ["t", t as string],
        ],
      }),
    );
    read[id as string] = nowS;
  }
  for (let i = 0; i < n; i += 1) {
    const peer = getPublicKey(generateSecretKey());
    peers.push(peer);
    ev.push(
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
    );
    const hist = opts.history ?? 1;
    const base = nowS - 3_000 - i * 10;
    for (let h = 0; h < hist; h += 1) {
      ev.push(
        mockEvent({
          id: hexId(seq++),
          kind: 9,
          pubkey: peer,
          created_at: base - (hist - h),
          tags: [["h", dmId(i)]],
          content: `Earlier ${h} in ${peerName(i)}`,
        }),
      );
    }
    read[dmId(i)] = base;
    const u = opts.unreadAtBoot?.[i] ?? 0;
    for (let k = 0; k < u; k += 1) {
      ev.push(
        mockEvent({
          id: hexId(seq++),
          kind: 9,
          pubkey: peer,
          created_at: base + 10 + k,
          tags: [["h", dmId(i)]],
          content: `Backlog ${k} in ${peerName(i)}`,
        }),
      );
    }
  }
  return { viewerKey, viewer, peers, ev, read, nowS, opts };
}
type Fx = ReturnType<typeof build>;

async function open(
  page: Page,
  fx: Fx,
  path = `/repos?c=${GENERAL}`,
  relayOpts: Parameters<typeof installMockRelay>[2] = {},
): Promise<MockRelay> {
  await page.addInitScript(
    ({ read, opts, dmIds }) => {
      try {
        localStorage.setItem("buzz.read-state.v1", JSON.stringify(read));
        localStorage.setItem(
          "buzz.collapsed-sections.v1",
          JSON.stringify(opts.collapsed ?? []),
        );
        localStorage.setItem(
          "buzz.channel-prefs.v1",
          JSON.stringify({
            favorites: (opts.favorites ?? []).map((i: number) => ({
              kind: "channel",
              id: dmIds[i],
              at: Date.now(),
            })),
            muted: (opts.muted ?? []).map((i: number) => dmIds[i]),
          }),
        );
        localStorage.setItem(
          "buzz.notifications.v1",
          JSON.stringify({
            mode: "all",
            desktopEnabled: true,
            soundEnabled: false,
          }),
        );
        localStorage.setItem("buzz-theme", "buzz");
        localStorage.setItem("buzz-follow-system", "false");
      } catch {}
      // OS notification probe.
      const w = window as unknown as { __os: string[] };
      w.__os = [];
      class FakeNotification {
        static permission = "granted";
        static requestPermission() {
          return Promise.resolve("granted");
        }
        onclick: unknown;
        constructor(title: string) {
          w.__os.push(title);
        }
        close() {}
      }
      (window as unknown as { Notification: unknown }).Notification =
        FakeNotification;
    },
    {
      read: fx.read,
      opts: fx.opts,
      dmIds: Array.from({ length: fx.opts.dmCount ?? DM_COUNT }, (_, i) =>
        dmId(i),
      ),
    },
  );
  await routeUsageHub(page);
  await installHatchMock(page);
  const relay = await installMockRelay(page, fx.ev, relayOpts);
  await signIn(page, path, fx.viewerKey);
  if (page.viewportSize()!.width > 600)
    await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  // Let every counting batch reach its first EOSE: a message that lands
  // earlier is backfill (pill, no toast) by design. Measured: pushing right
  // after the sidebar mounts toasts in no "away" run (see the report).
  await page.waitForTimeout(4_000);
  return relay;
}

const dmSection = (page: Page) =>
  page
    .getByTestId("channel-sidebar")
    .locator('section[aria-label="Direct messages"]');
const dmRows = (page: Page) =>
  dmSection(page).locator("ul > li > button[data-active]");
const dmRow = (page: Page, name: string): Locator =>
  dmRows(page).filter({
    has: page.locator("span.truncate", { hasText: name }),
  });
const badge = (row: Locator) => row.getByTestId("dm-row-badge");
const toasts = (page: Page) => page.getByTestId("buzz-toast-message");

async function mouse(page: Page, mode: "resting" | "away") {
  if (mode === "resting") {
    await dmRows(page).nth(2).hover();
  } else {
    await page.mouse.move(700, 600);
  }
}

function live(
  fx: Fx,
  i: number,
  extra: Partial<MockEvent> = {},
  ageS = 0,
): MockEvent {
  const id = nextId();
  return mockEvent({
    id,
    kind: 9,
    pubkey: fx.peers[i] as string,
    created_at: Math.floor(Date.now() / 1_000) - ageS,
    tags: [["h", dmId(i)]],
    content: `Live ${id.slice(-4)}`,
    ...extra,
  });
}

async function attention(page: Page, on: boolean) {
  await page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (v ? "visible" : "hidden"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => !v,
    });
    document.hasFocus = () => v;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(v ? "focus" : "blur"));
  }, on);
}

const trace = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __buzzUnreadTrace: Array<Record<string, unknown>>;
        }
      ).__buzzUnreadTrace,
  );
const osCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __os: string[] }).__os.length);

test.use({ viewport: { width: 1_440, height: 1_000 } });

for (const mode of ["resting", "away"] as const) {
  test.describe(`mouse ${mode}`, () => {
    test(`#1 DM while viewing another channel: toast, row in slice, pill 1 then 2 [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      relay.push(live(fx, TARGET));
      await expect(toasts(page).first()).toBeVisible({ timeout: 1_500 });
      const row = dmRow(page, peerName(TARGET));
      await expect(badge(row)).toHaveText("1");
      // bold name
      const w = await row
        .locator("span.truncate")
        .first()
        .evaluate((e) => Number(getComputedStyle(e).fontWeight));
      expect(w).toBeGreaterThanOrEqual(600);
      relay.push(live(fx, TARGET));
      await expect(badge(row)).toHaveText("2");
    });

    test(`#2 DM while viewing that DM: no toast, no pill, marker advances [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx, `/repos?c=${dmId(5)}`);
      await mouse(page, mode);
      const m = live(fx, 5);
      relay.push(m);
      await expect(page.getByText(m.content)).toBeVisible();
      await page.waitForTimeout(1_200);
      await expect(toasts(page)).toHaveCount(0);
      await expect(badge(dmRow(page, peerName(5)))).toHaveCount(0);
      const moved = (await trace(page)).filter(
        (t) => t.type === "markerMoved" && t.id === dmId(5),
      );
      expect(moved.at(-1)?.to).toBe(m.created_at);
    });

    test(`#3 DM open but tab hidden: pill N + OS notification; clears when attended [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx, `/repos?c=${dmId(5)}`);
      await page.waitForTimeout(800);
      await attention(page, false);
      await mouse(page, mode);
      relay.push(live(fx, 5));
      relay.push(live(fx, 5));
      const row = dmRow(page, peerName(5));
      await expect(badge(row)).toHaveText("2");
      expect(await osCount(page)).toBeGreaterThan(0);
      await attention(page, true);
      await expect(badge(row)).toHaveCount(0);
    });

    test(`#3b window unfocused but tab VISIBLE: pill shows, is any alert raised? [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx, `/repos?c=${dmId(5)}`);
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        document.hasFocus = () => false;
        window.dispatchEvent(new Event("blur"));
      });
      await mouse(page, mode);
      relay.push(live(fx, 5));
      await expect(badge(dmRow(page, peerName(5)))).toHaveText("1");
      await page.waitForTimeout(500);
      // Informational: no toast (viewing) and no OS notification (not hidden).
      const os = await osCount(page);
      const t = await toasts(page).count();
      expect(
        os + t,
        "unfocused-but-visible window got a row pill but NO toast and NO OS notification",
      ).toBeGreaterThan(0);
    });

    test(`#4 reconnect: 3 DMs missed -> 3 pills in 5s, no toast storm [${mode}]`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const fx = build();
      const relay = await open(page, fx);
      await page.waitForTimeout(800);
      await attention(page, false);
      relay.dropConnections();
      for (const i of [16, 19, 22]) relay.push(live(fx, i));
      await attention(page, true);
      await mouse(page, mode);
      const t0 = Date.now();
      for (const i of [16, 19, 22]) {
        await expect(badge(dmRow(page, peerName(i)))).toHaveText("1", {
          timeout: 15_000,
        });
      }
      const dt = Date.now() - t0;
      const shown = await toasts(page).count();
      test.info().annotations.push({
        type: "evidence",
        description: `pills after ${dt}ms, toasts=${shown}`,
      });
      expect(dt).toBeLessThan(5_000);
      expect(shown, "toast storm after reconnect").toBeLessThanOrEqual(1);
    });

    test(`#5 reload with 2 unread DMs: rows visible with counts, no backlog toasts [${mode}]`, async ({
      page,
    }) => {
      const fx = build({ unreadAtBoot: { 20: 3, 11: 1 } });
      await open(page, fx);
      await mouse(page, mode);
      await expect(badge(dmRow(page, peerName(20)))).toHaveText("3");
      await expect(badge(dmRow(page, peerName(11)))).toHaveText("1");
      const first = await dmRows(page).first().textContent();
      expect(first).toMatch(/Peer (20|11)/);
      await page.waitForTimeout(2_000);
      await expect(toasts(page)).toHaveCount(0);
    });

    test(`#6 muted DM: no toast, no pill, not bold [${mode}]`, async ({
      page,
    }) => {
      const fx = build({ muted: [TARGET] });
      const relay = await open(page, fx);
      await mouse(page, mode);
      relay.push(live(fx, TARGET));
      await page.waitForTimeout(1_500);
      await expect(toasts(page)).toHaveCount(0);
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveCount(0);
      // informational: OS notification for a muted DM
      test.info().annotations.push({
        type: "evidence",
        description: `muted DM OS notifications=${await osCount(page)}`,
      });
    });

    test(`#8 brand-new DM: row + toast + pill 1 (relay sends 39000 then message at once) [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      const nid = "d0000000-0000-4000-8000-0000000000ff";
      const peer = getPublicKey(generateSecretKey());
      relay.push(
        mockEvent({
          id: nextId(),
          kind: 39000,
          tags: [
            ["d", nid],
            ["name", "raw-new"],
            ["t", "dm"],
            ["p", fx.viewer],
            ["p", peer],
          ],
        }),
        mockEvent({
          id: nextId(),
          kind: 0,
          pubkey: peer,
          content: JSON.stringify({ display_name: "Newcomer" }),
        }),
      );
      relay.push(
        mockEvent({
          id: nextId(),
          kind: 9,
          pubkey: peer,
          tags: [["h", nid]],
          content: "hello brand new",
        }),
      );
      await expect(badge(dmRow(page, "Newcomer"))).toHaveText("1", {
        timeout: 8_000,
      });
      await expect(toasts(page).first()).toBeVisible({ timeout: 3_000 });
    });

    test(`#8b brand-new DM, message 1.5s after the 39000 [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      const nid = "d0000000-0000-4000-8000-0000000000fe";
      const peer = getPublicKey(generateSecretKey());
      relay.push(
        mockEvent({
          id: nextId(),
          kind: 39000,
          tags: [
            ["d", nid],
            ["name", "raw-new2"],
            ["t", "dm"],
            ["p", fx.viewer],
            ["p", peer],
          ],
        }),
        mockEvent({
          id: nextId(),
          kind: 0,
          pubkey: peer,
          content: JSON.stringify({ display_name: "Latecomer" }),
        }),
      );
      await page.waitForTimeout(1_500);
      relay.push(
        mockEvent({
          id: nextId(),
          kind: 9,
          pubkey: peer,
          tags: [["h", nid]],
          content: "hello later",
        }),
      );
      await expect(badge(dmRow(page, "Latecomer"))).toHaveText("1", {
        timeout: 8_000,
      });
      await expect(toasts(page).first()).toBeVisible({ timeout: 3_000 });
    });

    test(`#9 hidden DM receives message: resurfaces with pill + toast [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const snap = (at: number, hidden: string[]) =>
        mockEvent({
          id: nextId(),
          kind: 30622,
          created_at: at,
          tags: [
            ["d", fx.viewer],
            ["p", fx.viewer],
            ...hidden.map((h) => ["h", h]),
          ],
        });
      fx.ev.push(snap(fx.nowS - 100, [dmId(TARGET)]));
      const relay = await open(page, fx);
      await expect(dmRow(page, peerName(TARGET))).toHaveCount(0);
      await mouse(page, mode);
      relay.push(live(fx, TARGET));
      relay.push(snap(Math.floor(Date.now() / 1_000) + 1, []));
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveText("1", {
        timeout: 8_000,
      });
      await expect(toasts(page).first()).toBeVisible();
    });

    test(`#10 channel + forum messages [${mode}]`, async ({ page }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      relay.push(
        mockEvent({
          id: nextId(),
          kind: 9,
          pubkey: getPublicKey(generateSecretKey()),
          tags: [["h", RANDOM]],
          content: "chan msg",
        }),
      );
      await expect(toasts(page).first()).toBeVisible({ timeout: 2_000 });
      const sb = page.getByTestId("channel-sidebar");
      await expect(
        sb.locator("button", { hasText: "random" }).first(),
      ).toContainText(/1/);
      relay.push(
        mockEvent({
          id: nextId(),
          kind: 9,
          pubkey: getPublicKey(generateSecretKey()),
          tags: [["h", FORUM]],
          content: "forum post",
        }),
      );
      await expect(sb.getByTestId("nav-disclosure-unread")).toBeVisible({
        timeout: 3_000,
      });
    });

    test(`#11 thread reply in a DM counts, toast says in thread [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      const parent = live(fx, TARGET);
      relay.push(parent);
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveText("1");
      relay.push(
        live(fx, TARGET, {
          tags: [
            ["h", dmId(TARGET)],
            ["e", parent.id, "", "reply"],
          ],
          content: "a thread reply",
        }),
      );
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveText("2");
      // Exact copy (tightened): the reply's toast meta reads "DM · in thread";
      // the parent's toast says plain "DM", so only the reply can match.
      await expect(
        toasts(page).filter({ hasText: "a thread reply" }),
      ).toContainText("DM · in thread");
    });

    test(`#12 own send from another device: no toast, no pill [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      relay.push(live(fx, TARGET, { pubkey: fx.viewer }));
      await page.waitForTimeout(1_500);
      await expect(toasts(page)).toHaveCount(0);
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveCount(0);
      const idx = await dmRows(page).evaluateAll((els, name) => {
        return els.findIndex((e) => e.textContent?.includes(name as string));
      }, peerName(TARGET));
      test.info().annotations.push({
        type: "evidence",
        description: `own-send row index ${idx} (expect 0-3)`,
      });
      expect(idx, "own send should lift row into top four").toBeGreaterThan(-1);
      expect(idx).toBeLessThan(4);
    });

    test(`#12b unread foreign msg then own send from other device keeps pill? [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      relay.push(live(fx, TARGET));
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveText("1");
      relay.push(live(fx, TARGET, { pubkey: fx.viewer }));
      await page.waitForTimeout(1_000);
      await expect(
        badge(dmRow(page, peerName(TARGET))),
        "foreign message still unread (count 1) but own newer sample hides the row",
      ).toHaveText("1");
    });

    test(`#15/#16 wake for other: silent; wake for viewer: toast + pill [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      const WAKE =
        "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271";
      relay.push(
        live(fx, TARGET, {
          pubkey: WAKE,
          tags: [
            ["h", dmId(TARGET)],
            ["p", "ab".repeat(32)],
          ],
          content: "continue: other",
        }),
      );
      await page.waitForTimeout(1_200);
      await expect(toasts(page)).toHaveCount(0);
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveCount(0);
      relay.push(
        live(fx, TARGET, {
          pubkey: WAKE,
          tags: [
            ["h", dmId(TARGET)],
            ["p", fx.viewer],
          ],
          content: "continue: me",
        }),
      );
      await expect(badge(dmRow(page, peerName(TARGET)))).toHaveText("1");
      await expect(toasts(page).first()).toBeVisible();
    });

    test(`#17 8 unread DMs: all rendered or N more . K unread, newest first [${mode}]`, async ({
      page,
    }) => {
      const fx = build();
      const relay = await open(page, fx);
      await mouse(page, mode);
      const idxs = [23, 22, 21, 20, 19, 18, 17, 16];
      for (const i of idxs) {
        relay.push(live(fx, i));
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(1_000);
      const rendered = await dmRows(page)
        .filter({ has: page.getByTestId("dm-row-badge") })
        .count();
      const more = await dmSection(page)
        .getByTestId("section-more")
        .textContent();
      test.info().annotations.push({
        type: "evidence",
        description: `pills rendered=${rendered} more="${more}"`,
      });
      if (rendered < 8) expect(more).toMatch(/8|unread/i);
      else expect(rendered).toBe(8);
      // newest first: Peer 16 pushed last
      const names = await dmRows(page)
        .locator("span.truncate")
        .allTextContents();
      expect(names[0]).toContain(peerName(16));
    });

    test(`#18 DMs collapsed: header dot + count; expand shows unread on top [${mode}]`, async ({
      page,
    }) => {
      const fx = build({ collapsed: ["dms"] });
      const relay = await open(page, fx);
      await page.mouse.move(mode === "resting" ? 100 : 700, 300);
      relay.push(live(fx, TARGET));
      relay.push(live(fx, 3));
      await expect(
        dmSection(page).getByTestId("section-unread-dot"),
      ).toBeVisible({ timeout: 3_000 });
      // The folded header counts UNREAD conversations, not all 24.
      await expect(dmSection(page).getByTestId("section-count")).toHaveText(
        "2",
      );
      await dmSection(page)
        .getByRole("button", { name: /direct messages/i })
        .first()
        .click();
      await page.mouse.move(700, 600);
      const top = await dmRows(page).first().textContent();
      expect(top).toMatch(/Peer (18|03)/);
    });

    test(`#19 Mark read from DM row menu [${mode}]`, async ({ page }) => {
      const fx = build();
      const relay = await open(page, fx);
      relay.push(live(fx, 2));
      const row = dmRow(page, peerName(2));
      await expect(badge(row)).toHaveText("1");
      await row.click({ button: "right" });
      const item = page.getByRole("menuitem", { name: /mark.*read/i });
      await expect(item, "DM row menu has no Mark read").toBeVisible({
        timeout: 2_000,
      });
      await item.click();
      await expect(badge(row)).toHaveCount(0);
      const last = (await trace(page))
        .filter((t) => t.type === "markerMoved")
        .at(-1);
      expect(last?.source).toBe("menu");
    });

    test(`#20 favorited DM behaves as #1 [${mode}]`, async ({ page }) => {
      const fx = build({ favorites: [TARGET] });
      const relay = await open(page, fx);
      await mouse(page, mode);
      relay.push(live(fx, TARGET));
      await expect(toasts(page).first()).toBeVisible({ timeout: 1_500 });
      const fav = page
        .getByTestId("channel-sidebar")
        .locator('section[aria-label="Favorites"]');
      await expect(
        fav.locator("button[data-active]", { hasText: peerName(TARGET) }),
      ).toContainText("1");
    });
  });
}

test("#13/#14 two devices (simulated, shared mock): hidden B keeps A pill, attended B clears A, A mouse resting", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fx = build();
  const cA = await browser.newContext();
  const cB = await browser.newContext();
  const pA = await cA.newPage();
  const pB = await cB.newPage();
  const r: { a?: MockRelay; b?: MockRelay } = {};
  try {
    r.a = await open(pA, fx, `/repos?c=${GENERAL}`, {
      onPublish: (e) => {
        if (e.kind === 30078) r.b?.push(e);
      },
    });
    r.b = await open(pB, fx, `/repos?c=${dmId(TARGET)}`, {
      onPublish: (e) => {
        if (e.kind === 30078) r.a?.push(e);
      },
    });
    await pB.waitForTimeout(1_000);
    await mouse(pA, "resting");
    await attention(pB, false);
    const m = live(fx, TARGET);
    r.a.push(m);
    r.b.push(m);
    const rowA = dmRow(pA, peerName(TARGET));
    await expect(badge(rowA)).toHaveText("1");
    await pA.waitForTimeout(8_000);
    await expect(badge(rowA), "#14 hidden B must not clear A").toHaveText("1");
    const t0 = Date.now();
    await attention(pB, true);
    await expect(badge(rowA)).toHaveCount(0, { timeout: 15_000 });
    test.info().annotations.push({
      type: "evidence",
      description: `#13 clear latency ${Date.now() - t0}ms`,
    });
    const last = (await trace(pA))
      .filter((t) => t.type === "markerMoved" && t.id === dmId(TARGET))
      .at(-1);
    expect(String(last?.source)).toMatch(/^sync:/);
  } finally {
    await cA.close();
    await cB.close();
  }
});

test("#21 phone layout: Channels tab badge equals rows with pills", async ({
  page,
}) => {
  const fx = build({ muted: [7] });
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = await open(page, fx, "/repos");
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: "test-results/phone-list.png" });
  for (const i of [3, 7, 20]) relay.push(live(fx, i));
  relay.push(
    mockEvent({
      id: nextId(),
      kind: 9,
      pubkey: getPublicKey(generateSecretKey()),
      tags: [["h", RANDOM]],
      content: "chan",
    }),
  );
  await page.waitForTimeout(1_500);
  const nav = page.locator("nav").filter({ hasText: "Work" }).last();
  const txt = ((await nav.textContent()) ?? "").trim();
  await page.screenshot({ path: "test-results/phone-after.png" });
  const dmPills = await page.getByTestId("dm-row-badge").count();
  test.info().annotations.push({
    type: "evidence",
    description: `tabbar="${txt}" dmPills=${dmPills}`,
  });
  console.log(`PHONE tabbar="${txt}" dmPills=${dmPills}`);
  expect(txt).toMatch(/Channels4/);
});

test("#22 relay CLOSED one batch: health sweep heals within 60s, missed message gets pill", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = build();
  const relay = await open(page, fx);
  await page.waitForTimeout(5_000);
  const closed = relay.closeSubs((fs) =>
    fs.some(
      (f) =>
        Array.isArray(f["#h"]) &&
        (f["#h"] as string[]).includes(dmId(TARGET)) &&
        typeof f.since === "number",
    ),
  );
  expect(closed).toBeGreaterThan(0);
  relay.add(live(fx, TARGET)); // missed: stored, never fanned out
  const row = dmRow(page, peerName(TARGET));
  await expect(badge(row)).toHaveText("1", { timeout: 75_000 });
});

test("boot cost: 68 DMs with history, 10 unread", async ({ page }) => {
  const unread: Record<number, number> = {};
  for (let i = 0; i < 10; i += 1) unread[i * 6] = 5;
  const fx = build({ dmCount: 68, history: 30, unreadAtBoot: unread });
  const frames: unknown[][] = [];
  const relay = await open(page, fx, `/repos?c=${GENERAL}`);
  void frames;
  await page.waitForTimeout(3_000);
  const s = relay.stats;
  const kind9Reqs = 0;
  void kind9Reqs;
  test.info().annotations.push({
    type: "evidence",
    description: `REQs=${s.reqs} eventFrames=${s.eventFrames} bytes=${s.bytes}`,
  });
  console.log(
    `BOOTCOST reqs=${s.reqs} events=${s.eventFrames} bytes=${s.bytes}`,
  );
});
