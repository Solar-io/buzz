import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { expect, test, type Page, type Route } from "@playwright/test";
import { decode as nip19Decode } from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { publishAs, type UnsignedTemplate } from "./helpers/relaySeed";
import { signIn } from "./helpers/signIn";

/**
 * Agent Stage Mode, end to end, against a LIVE relay (design §10 "Live
 * browser e2e" + the §15 amendment).
 *
 * Two identities, because the interesting rules are about WHO posted:
 *
 *  - the AGENT (`E2E_AGENT_NSEC` + `E2E_AUTH_TAG`) runs the real `buzz stage`
 *    CLI — uploads, the open event, `stage show` — and signs the fast
 *    back-to-back showings the pacing cases need (a CLI process per showing
 *    takes ~1 s to connect, which would make a 1 s hold assertion pass with
 *    or without the hold: the equal-on-both-sides trap);
 *  - the VIEWER (`E2E_VIEWER_NSEC`, optional `E2E_VIEWER_AUTH_TAG`) is signed
 *    into the browser. It must be a relay member (a fresh key is refused at
 *    AUTH). The "Stage ready" banner only fires for a DIFFERENT author's
 *    open, so a single key cannot test it at all.
 *
 * `E2E_BUZZ_BIN` defaults to `../target/debug/buzz` (run `cargo build -p
 * buzz-cli` first). Build the web app with `VITE_RELAY_URL` = the same relay
 * (`VITE_RELAY_URL=$E2E_RELAY_WS pnpm build`) — the preview server serves
 * `dist/` as built, and a bundle pointed at any other relay fails ALL nine
 * cases (the viewer never sees the agent's events). The webServer reuses an
 * already-running preview on `PLAYWRIGHT_PORT`, so make sure a stale one is
 * not still up.
 * Skips when any required variable is unset.
 *
 * TTS never reaches a real bridge: `**\/tts` is fulfilled with exactly 1.0 s
 * of 24 kHz PCM silence, so "speech done" is a known, measurable duration.
 * Cross-origin media from a 127.0.0.1 origin is shimmed with CORS headers
 * (the dev relay does not list that origin).
 */

const RELAY_WS = process.env.E2E_RELAY_WS ?? "";
const AGENT_NSEC = process.env.E2E_AGENT_NSEC ?? "";
const AUTH_TAG = process.env.E2E_AUTH_TAG ?? "";
const VIEWER_NSEC = process.env.E2E_VIEWER_NSEC ?? "";
const VIEWER_AUTH_TAG = process.env.E2E_VIEWER_AUTH_TAG || undefined;
const BUZZ_BIN = resolve(
  process.env.E2E_BUZZ_BIN ?? join(process.cwd(), "..", "target/debug/buzz"),
);

const LANDSCAPE = { width: 1180, height: 820 };
const PORTRAIT = { width: 820, height: 1180 };
/** 1.0 s of mono int16 PCM at the bridge's 24 kHz. */
const TTS_SECONDS = 1.0;
const TTS_BYTES = 24_000 * 2 * TTS_SECONDS;

/** Evidence screenshots, only when `E2E_SHOT_DIR` is set. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("not mounted");
  return value;
}

function secretOf(nsec: string): Uint8Array {
  const decoded = nip19Decode(nsec);
  if (decoded.type !== "nsec") throw new Error("expected an nsec1… key");
  return decoded.data;
}

// ── Generated neutral images (solid gradients, nothing else) ─────────────

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function png(width: number, height: number, rgb: [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    const shade = 0.6 + (0.4 * y) / height;
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = Math.round(rgb[0] * shade);
      row[2 + x * 3] = Math.round(rgb[1] * shade);
      row[3 + x * 3] = Math.round(rgb[2] * shade);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── The agent side: the real CLI ─────────────────────────────────────────

interface Media {
  url: string;
  sha256: string;
  type: string;
  size: number;
}
interface Deck {
  session: string;
  channel: string;
  media: Media[];
  texts: string[];
}

const WORK = join(tmpdir(), `stage-e2e-${process.pid}`);

function cli(args: string[]): string {
  return execFileSync(BUZZ_BIN, args, {
    env: {
      ...process.env,
      BUZZ_PRIVATE_KEY: AGENT_NSEC,
      BUZZ_AUTH_TAG: AUTH_TAG,
      BUZZ_RELAY_URL: RELAY_WS,
      BUZZ_STAGE_DIR: join(WORK, "state"),
    },
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function lastJson<T>(out: string): T {
  const line = out.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as T;
}

/** `buzz stage open` — uploads three generated frames, then the open event. */
function stageOpen(channel: string, voice: boolean, title: string): Deck {
  mkdirSync(WORK, { recursive: true });
  const colors: [number, number, number][] = [
    [200, 60, 60],
    [60, 110, 210],
    [60, 170, 90],
  ];
  const texts = colors.map((_, i) => `${title}: frame ${i}.`);
  const parts = colors.map((rgb, i) => {
    const file = join(WORK, `frame-${i}.png`);
    writeFileSync(file, png(480, 320, rgb));
    return { label: `frame${i}`, text: texts[i], image: file };
  });
  const deckFile = join(WORK, `deck-${Date.now()}.json`);
  writeFileSync(deckFile, JSON.stringify({ title, voice, parts }));
  const opened = lastJson<{ session: string; total: number }>(
    cli(["stage", "open", "--channel", channel, "--deck", deckFile]),
  );
  expect(opened.total).toBe(3);
  const state = JSON.parse(
    readFileSync(join(WORK, "state", `${opened.session}.json`), "utf8"),
  ) as { palette: { media: Media }[] };
  return {
    session: opened.session,
    channel,
    media: state.palette.map((p) => p.media),
    texts,
  };
}

/** A showing, signed directly: same shape `stage show` publishes. */
function showing(
  deck: Deck,
  i: number,
  text: string,
  hold?: boolean,
): UnsignedTemplate {
  const media = deck.media[i];
  const tag: Record<string, unknown> = { v: 1, op: "part", s: deck.session, i };
  if (hold !== undefined) tag.hold = hold;
  return {
    kind: 9,
    tags: [
      ["h", deck.channel],
      [
        "imeta",
        `url ${media.url}`,
        `m ${media.type}`,
        `x ${media.sha256}`,
        `size ${media.size}`,
      ],
      ["stage", JSON.stringify(tag)],
    ],
    content: `${text}\n![image](${media.url})`,
  };
}

/** Read events back as `secretKey` (AUTH, REQ, collect until EOSE). */
async function query(
  secretKey: Uint8Array,
  filter: Record<string, unknown>,
  authTag?: string,
): Promise<
  { id: string; pubkey: string; tags: string[][]; content: string }[]
> {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(RELAY_WS);
    const events: {
      id: string;
      pubkey: string;
      tags: string[][];
      content: string;
    }[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("query timed out"));
    }, 15_000);
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as unknown[];
      if (frame[0] === "AUTH") {
        const tags: string[][] = [
          ["relay", RELAY_WS],
          ["challenge", String(frame[1])],
        ];
        if (authTag) tags.push(JSON.parse(authTag) as string[]);
        socket.send(
          JSON.stringify([
            "AUTH",
            finalizeEvent(
              {
                kind: 22242,
                created_at: Math.floor(Date.now() / 1000),
                tags,
                content: "",
              },
              secretKey,
            ),
          ]),
        );
      } else if (frame[0] === "OK") {
        socket.send(JSON.stringify(["REQ", "q", filter]));
      } else if (frame[0] === "EVENT") {
        events.push(frame[2] as (typeof events)[number]);
      } else if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
        clearTimeout(timer);
        socket.close();
        resolvePromise(events);
      }
    };
    socket.onerror = () => reject(new Error("relay unreachable"));
  });
}

// ── The browser side: instrumentation + stubs ────────────────────────────

/**
 * Page-clock instrumentation, installed before any app code:
 *  - every AudioContext (U2 reads `.state`; exit must close it — U3),
 *  - a fake screen wake lock that counts acquire/release (U3),
 *  - WebSocket EVENT receive times by event id (arrival, same clock),
 *  - each change of the staged showing (`data-showing`) with its time,
 *  - every scheduled audio source, with the gain value it plays through.
 */
const INSTRUMENT = () => {
  type Rec = {
    ctxs: AudioContext[];
    shown: { id: string; t: number }[];
    rx: Record<string, number>;
    wake: { acquired: number; released: number };
    sources: { gain: number | null; t: number }[];
  };
  const w = window as unknown as { __stage: Rec } & typeof window;
  const S: Rec = {
    ctxs: [],
    shown: [],
    rx: {},
    wake: { acquired: 0, released: 0 },
    sources: [],
  };
  w.__stage = S;
  const NativeAC = window.AudioContext;
  if (NativeAC) {
    window.AudioContext = class extends NativeAC {
      constructor(options?: AudioContextOptions) {
        super(options);
        S.ctxs.push(this);
      }
    } as typeof AudioContext;
  }
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async () => {
        S.wake.acquired += 1;
        let released = false;
        return {
          released: false,
          type: "screen",
          addEventListener() {},
          removeEventListener() {},
          release: async () => {
            if (!released) S.wake.released += 1;
            released = true;
          },
        };
      },
    },
  });
  const dest = new WeakMap<AudioNode, AudioNode>();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    if (args[0] instanceof AudioNode) dest.set(this, args[0]);
    return (connect as (...a: unknown[]) => AudioNode).apply(this, args);
  } as typeof AudioNode.prototype.connect;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (
    this: AudioBufferSourceNode,
    ...args: number[]
  ) {
    const to = dest.get(this);
    if ((this.buffer?.length ?? 0) > 1) {
      S.sources.push({
        gain: to instanceof GainNode ? to.gain.value : null,
        t: performance.now(),
      });
    }
    return start.apply(this, args as []);
  };
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (message) => {
        const raw = String(message.data);
        if (!raw.startsWith('["EVENT"')) return;
        try {
          const id = (JSON.parse(raw) as [string, string, { id: string }])[2]
            .id;
          if (!(id in S.rx)) S.rx[id] = performance.now();
        } catch {
          // not ours
        }
      });
    }
  } as typeof WebSocket;
  let last: string | null = null;
  const scan = () => {
    const el = document.querySelector(
      '[data-testid="stage-image"],[data-testid="stage-image-loading"]',
    );
    const id = el?.getAttribute("data-showing") ?? null;
    if (id !== last) {
      last = id;
      if (id) S.shown.push({ id, t: performance.now() });
    }
  };
  new MutationObserver(scan).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-showing"],
  });
};

interface TtsCall {
  text: string;
}

async function stubNetwork(page: Page): Promise<TtsCall[]> {
  const calls: TtsCall[] = [];
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  };
  await page.route("**/tts", async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      text?: string;
    };
    calls.push({ text: body.text ?? "" });
    await route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/octet-stream" },
      body: Buffer.alloc(TTS_BYTES),
    });
  });
  const relayHttp = RELAY_WS.replace(/^ws/, "http").replace(/\/+$/, "");
  await page.route(`${relayHttp}/media/**`, async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), ...cors },
    });
  });
  await page.addInitScript(INSTRUMENT);
  return calls;
}

type Rec = {
  shown: { id: string; t: number }[];
  rx: Record<string, number>;
  wake: { acquired: number; released: number };
  sources: { gain: number | null; t: number }[];
};
const rec = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __stage: Rec }).__stage;
    return JSON.parse(
      JSON.stringify({
        shown: s.shown,
        rx: s.rx,
        wake: s.wake,
        sources: s.sources,
      }),
    ) as Rec;
  });
const ctxStates = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __stage: { ctxs: AudioContext[] } }
    ).__stage.ctxs.map((c) => c.state),
  );

/** Wait until `id` has been staged; returns its page-clock time. */
async function shownAt(page: Page, id: string, timeout = 15_000) {
  await expect
    .poll(async () => (await rec(page)).shown.some((s) => s.id === id), {
      timeout,
    })
    .toBe(true);
  return (await rec(page)).shown.find((s) => s.id === id)?.t ?? Number.NaN;
}

/**
 * Strictly increasing `created_at` seconds, always after "now".
 *
 * Showings sort by (created_at, event id) and nostr time is whole seconds,
 * so two showings posted in the same second are ordered by a RANDOM id —
 * see the "same-second" test below. Cases that are about something else
 * pin distinct seconds so they are deterministic.
 */
let lastTs = 0;
function nextTs(): number {
  lastTs = Math.max(Math.floor(Date.now() / 1000) + 1, lastTs + 1);
  return lastTs;
}

/** Publish one event as the agent and return its id. */
async function publishOne(
  secretKey: Uint8Array,
  template: UnsignedTemplate & { created_at?: number },
): Promise<string> {
  const ids: string[] = [];
  await publishMany(secretKey, [template], ids);
  return ids[0];
}

/**
 * Serial publish over one socket (relaySeed's ordering contract) that also
 * RECORDS the ids — `relaySeed.publishAs` signs internally and returns none.
 */
async function publishMany(
  secretKey: Uint8Array,
  templates: (UnsignedTemplate & { created_at?: number })[],
  ids: string[],
  authTag = AUTH_TAG,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = new WebSocket(RELAY_WS);
    let authed = false;
    let index = 0;
    let awaiting: string | null = null;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("publish timed out"));
    }, 30_000);
    const next = () => {
      if (index >= templates.length) {
        clearTimeout(timer);
        socket.close();
        resolvePromise();
        return;
      }
      const event = finalizeEvent(
        {
          ...templates[index],
          created_at:
            templates[index].created_at ?? Math.floor(Date.now() / 1000),
        },
        secretKey,
      );
      index += 1;
      awaiting = event.id;
      ids.push(event.id);
      socket.send(JSON.stringify(["EVENT", event]));
    };
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as unknown[];
      if (frame[0] === "AUTH") {
        const tags: string[][] = [
          ["relay", RELAY_WS],
          ["challenge", String(frame[1])],
        ];
        if (authTag) tags.push(JSON.parse(authTag) as string[]);
        socket.send(
          JSON.stringify([
            "AUTH",
            finalizeEvent(
              {
                kind: 22242,
                created_at: Math.floor(Date.now() / 1000),
                tags,
                content: "",
              },
              secretKey,
            ),
          ]),
        );
        return;
      }
      if (frame[0] !== "OK") return;
      if (!authed) {
        authed = true;
        next();
        return;
      }
      if (String(frame[1]) !== awaiting) return;
      if (frame[2] !== true) {
        clearTimeout(timer);
        socket.close();
        reject(new Error(`relay refused: ${String(frame[3])}`));
        return;
      }
      next();
    };
    socket.onerror = () => reject(new Error("relay unreachable"));
  });
}

/** Image pane / chat pane geometry, measured after layout settles. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const r = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      view: r("stage-view"),
      image: r("stage-image-pane"),
      chat: r("stage-chat-pane"),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────

test.describe("agent stage mode", () => {
  test.skip(
    !RELAY_WS || !AGENT_NSEC || !AUTH_TAG || !VIEWER_NSEC,
    "needs E2E_RELAY_WS + E2E_AGENT_NSEC + E2E_AUTH_TAG + E2E_VIEWER_NSEC (see the header)",
  );

  let agentKey: Uint8Array;
  let viewerKey: Uint8Array;
  let viewerPubkey: string;
  let dmId: string;
  const run = Date.now().toString(36);

  test.beforeAll(() => {
    agentKey = secretOf(AGENT_NSEC);
    viewerKey = secretOf(VIEWER_NSEC);
    viewerPubkey = getPublicKey(viewerKey);
    expect(getPublicKey(agentKey)).not.toBe(viewerPubkey);
    dmId = lastJson<{ dm_id: string }>(
      cli(["dms", "open", "--pubkey", viewerPubkey]),
    ).dm_id;
    expect(dmId).toMatch(/^[0-9a-f-]{36}$/);
  });

  /** A private stream channel owned by the agent with the viewer in it. */
  async function scratchChannel(): Promise<string> {
    const channelId = crypto.randomUUID();
    await publishAs(
      RELAY_WS,
      agentKey,
      [
        {
          kind: 9007,
          tags: [
            ["h", channelId],
            ["name", `stage-e2e-${channelId.slice(0, 6)}`],
            ["visibility", "private"],
            ["channel_type", "stream"],
          ],
          content: "",
        },
        {
          kind: 9000,
          tags: [
            ["h", channelId],
            ["p", viewerPubkey],
          ],
          content: "",
        },
      ],
      AUTH_TAG,
    );
    return channelId;
  }

  test("#1 DM: CLI open → card + banner in the DM → Open Stage → paced showings, reply, exit, replay", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(LANDSCAPE);
    const tts = await stubNetwork(page);
    await signIn(page, `/repos?c=${dmId}`, viewerKey, VIEWER_AUTH_TAG);
    await expect(page.getByTestId("channel-sidebar")).toBeVisible();
    // Let the DM's history land first, so the open below is "live".
    await page.waitForTimeout(3_000);

    // ── The real CLI, into the DM being viewed ───────────────────────────
    const title = `Stage e2e DM ${run}`;
    const deck = stageOpen(dmId, true, title);
    const card = page.getByTestId("stage-open-card").filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("stage-open-card-count")).toHaveText(
      "3 frames",
    );
    // Q3 banner: a DIFFERENT author's open, live, in the conversation shown.
    const banner = page.getByTestId("stage-ready-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(title);
    await shot(page, "01-dm-card-and-banner");

    await card.getByTestId("stage-open-button").click();
    const view = page.getByTestId("stage-view");
    await expect(view).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`stage=${deck.session}`));
    // The overlay replaced the banner.
    await expect(banner).toHaveCount(0);

    // U1: covers the viewport; image pane is 2/3 of the width; composer in
    // the chat pane.
    await expect(view).toHaveAttribute("data-layout", "split");
    const g = await geometry(page);
    expect(g.view).toEqual({ x: 0, y: 0, w: g.vw, h: g.vh });
    expect(g.image).not.toBeNull();
    expect(must(g.image).w / g.vw).toBeGreaterThan(0.667 - 0.01);
    expect(must(g.image).w / g.vw).toBeLessThan(0.667 + 0.01);
    expect(must(g.chat).x).toBeLessThan(must(g.image).x);
    await expect(
      page.getByTestId("stage-chat-pane").getByPlaceholder("Reply…"),
    ).toBeVisible();

    // U2: the Open Stage tap unlocked audio.
    await expect.poll(() => ctxStates(page)).toContain("running");

    // ── Showing #0 via the CLI's primary verb ───────────────────────────
    // History settles first (see BUG-6 in the Esc test).
    await page.waitForTimeout(2_000);
    const shown0 = lastJson<{ event_id?: string; id?: string }>(
      cli([
        "stage",
        "show",
        "--session",
        deck.session,
        "--index",
        "0",
        "--hold",
        "on",
      ]),
    );
    const firstId = shown0.event_id ?? shown0.id ?? "";
    expect(firstId).toMatch(/^[0-9a-f]{64}$/);
    await shownAt(page, firstId);
    await expect(page.getByTestId("stage-position")).toHaveText("1/1");
    // It is spoken through the (stubbed) bridge.
    await expect
      .poll(() => tts.some((c) => c.text.includes("frame 0")))
      .toBe(true);

    // ── P1: two HELD showings published back to back (ms apart) ─────────
    const heldIds: string[] = [];
    await publishMany(
      agentKey,
      [
        { ...showing(deck, 1, `${title}: held A.`), created_at: nextTs() },
        {
          ...showing(deck, 2, `${title}: held B.`, true),
          created_at: nextTs(),
        },
      ],
      heldIds,
    );
    const [aId, bId] = heldIds;
    const tA = await shownAt(page, aId, 20_000);
    const tB = await shownAt(page, bId, 20_000);
    const r1 = await rec(page);
    // Both arrived within a moment of each other...
    expect(Math.abs(r1.rx[bId] - r1.rx[aId])).toBeLessThan(500);
    // ...and B still waited out A's 1.0 s of speech (+ the 600 ms gap).
    const heldGap = tB - tA;
    test.info().annotations.push({
      type: "P1",
      description: `held A→B staged ${Math.round(heldGap)} ms apart (arrived ${Math.round(r1.rx[bId] - r1.rx[aId])} ms apart)`,
    });
    console.log(`[stage-e2e] P1 held gap ${Math.round(heldGap)} ms`);
    // Design P1: ≥ the 1.0 s of speech. The pacer adds STAGE_GAP_MS (600)
    // on top, so ≥ 1.5 s also pins the gap (a 0 ms gap measures ~1.0 s).
    expect(heldGap).toBeGreaterThanOrEqual(TTS_SECONDS * 1000);
    expect(heldGap).toBeGreaterThanOrEqual(TTS_SECONDS * 1000 + 500);

    // ── §15.2: hold:false shows at once while speech is pending; a held
    //    showing queued before it is released silently ──────────────────
    const fastIds: string[] = [];
    // Same frame as showing A (i=1) → a second showing of one frame.
    await publishMany(
      agentKey,
      [
        {
          ...showing(deck, 1, `${title}: queued silently.`, true),
          created_at: nextTs(),
        },
        {
          ...showing(deck, 0, `${title}: interrupt now.`, false),
          created_at: nextTs(),
        },
      ],
      fastIds,
    );
    const [queuedId, nowId] = fastIds;
    const tNow = await shownAt(page, nowId, 10_000);
    const r2 = await rec(page);
    const arrivalToShow = tNow - r2.rx[nowId];
    test.info().annotations.push({
      type: "hold:false",
      description: `arrival→staged ${Math.round(arrivalToShow)} ms`,
    });
    console.log(
      `[stage-e2e] hold:false arrival→staged ${Math.round(arrivalToShow)} ms`,
    );
    // B's speech (1.0 s) + gap would hold a HELD showing ≥ ~1.6 s from B.
    expect(arrivalToShow).toBeLessThan(400);
    // The queued held showing was never staged...
    expect(r2.shown.some((s) => s.id === queuedId)).toBe(false);
    // ...but its chat row is visible (chat never shows posts out of order).
    await expect(
      page
        .getByTestId("stage-chat-list")
        .getByText(`${title}: queued silently.`),
    ).toBeVisible();
    // ...and it was never spoken.
    await page.waitForTimeout(2_500);
    expect(tts.some((c) => c.text.includes("queued silently"))).toBe(false);
    expect(tts.some((c) => c.text.includes("interrupt now"))).toBe(true);
    // Five showings, frame 1 shown twice (A + queued) and frame 0 twice.
    await expect(page.getByTestId("stage-position")).toHaveText("5/5");
    await shot(page, "02-landscape-5-showings");

    // ── Prev / Next / Live (local only) ──────────────────────────────────
    await page.getByTestId("stage-image-pane").hover();
    await page.getByTestId("stage-prev").click();
    await expect(page.getByTestId("stage-position")).toHaveText("4/5");
    await page.getByTestId("stage-prev").click();
    await expect(page.getByTestId("stage-position")).toHaveText("3/5");
    await shot(page, "03-prev-live-button");
    await expect(page.locator(`[data-showing="${bId}"]`)).toBeVisible();
    await page.getByTestId("stage-next").click();
    await expect(page.getByTestId("stage-position")).toHaveText("4/5");
    await page.getByTestId("stage-live").click();
    await expect(page.getByTestId("stage-position")).toHaveText("5/5");
    await expect(page.locator(`[data-showing="${nowId}"]`)).toBeVisible();
    await expect(page.getByTestId("stage-live")).toHaveCount(0);

    // ── A reply from the Stage composer is a plain kind 9 ───────────────
    const reply = `stage e2e reply ${run}`;
    const composer = page
      .getByTestId("stage-chat-pane")
      .getByPlaceholder("Reply…");
    await composer.fill(reply);
    await composer.press("Enter");
    await expect(
      page.getByTestId("stage-chat-list").getByText(reply),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (
            await query(
              viewerKey,
              { kinds: [9], "#h": [dmId], authors: [viewerPubkey], limit: 20 },
              VIEWER_AUTH_TAG,
            )
          ).filter((e) => e.content.includes(reply)),
        { timeout: 15_000 },
      )
      .toHaveLength(1);
    const [replyEvent] = (
      await query(
        viewerKey,
        { kinds: [9], "#h": [dmId], authors: [viewerPubkey], limit: 20 },
        VIEWER_AUTH_TAG,
      )
    ).filter((e) => e.content.includes(reply));
    expect(replyEvent.tags.some((t) => t[0] === "stage")).toBe(false);
    expect(replyEvent.tags.some((t) => t[0] === "e")).toBe(false);

    // ── Back exits and restores the DM; audio + wake lock released (U3) ─
    const before = await rec(page);
    expect(before.wake.acquired).toBeGreaterThan(0);
    await page.goBack();
    await expect(view).toHaveCount(0);
    await expect(page).not.toHaveURL(/stage=/);
    await expect(page).toHaveURL(new RegExp(`c=${dmId}`));
    const after = await rec(page);
    expect(after.wake.released).toBe(after.wake.acquired);
    await expect.poll(() => ctxStates(page)).not.toContain("running");
    await shot(page, "04-after-back-timeline");
    // Every showing is an ordinary image message in the timeline.
    await expect(page.getByTestId("stage-part-chip")).not.toHaveCount(0);
    await expect(page.getByText(`${title}: held B.`).first()).toBeVisible();

    // ── Replay walks from showing #0 ────────────────────────────────────
    // The card is far above now; scroll the timeline up until it mounts.
    // Scroll with a real WHEEL, not `scrollTop -= n`: the timeline's follow
    // engine (features/agents/lib/scrollFollow.ts) only pauses tail-follow on
    // ARMED input (wheel/touch/keys). A programmatic scrollTop is "unarmed
    // movement", so follow stays on and the next ResizeObserver tick (an
    // image sizing in, an older page landing) re-pins the view to the newest
    // row — the card unmounts under the click. That was the intermittent
    // "Replay never clickable" failure; a user's wheel never hits it.
    const replayCard = page
      .getByTestId("stage-open-card")
      .filter({ hasText: title });
    const scroller = page.locator("div.buzz-timeline-scrollbar").first();
    const box = must(await scroller.boundingBox());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -600);
          return replayCard.count();
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    // Older history keeps paging in above it and re-mounting rows, so the
    // button can detach mid-click; retry a few short clicks.
    await expect(async () => {
      await replayCard
        .getByTestId("stage-replay-button")
        .click({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(view).toBeVisible();
    await expect(page.getByTestId("stage-position")).toHaveText(/^1\/\d+$/);
    await expect(page.locator(`[data-showing="${firstId}"]`)).toBeVisible();
    await expect.poll(() => ctxStates(page)).toContain("running");
    // And it advances by itself (replay is paced like live).
    await expect(page.locator(`[data-showing="${aId}"]`)).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press("Escape");
    await expect(view).toHaveCount(0);
  });

  test("#2 channel: voice:false shows on arrival (P2), portrait stacks, foreign part ignored (U4)", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(PORTRAIT);
    const tts = await stubNetwork(page);
    const channelId = await scratchChannel();
    // Let the channel's own system rows fall before the open (BUG-3 is
    // covered on its own below).
    await page.waitForTimeout(1_500);
    const title = `Stage e2e channel ${run}`;
    const deck = stageOpen(channelId, false, title);
    await signIn(page, `/repos?c=${channelId}`, viewerKey, VIEWER_AUTH_TAG);
    const card = page.getByTestId("stage-open-card").filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("stage-open-button").click();
    const view = page.getByTestId("stage-view");
    await expect(view).toBeVisible();

    // Portrait 820×1180: stacked — image on top (~2/3 height), chat below.
    await expect(view).toHaveAttribute("data-layout", "stacked");
    const g = await geometry(page);
    expect(must(g.image).y).toBeLessThan(must(g.chat).y);
    expect(must(g.image).h / g.vh).toBeGreaterThan(0.657);
    expect(must(g.image).h / g.vh).toBeLessThan(0.677);

    // P2: voice:false — each showing stages ≤ 250 ms after it arrives.
    for (const i of [0, 1, 2]) {
      const id = await publishOne(agentKey, {
        ...showing(deck, i, `${title}: silent ${i}.`, true),
        created_at: nextTs(),
      });
      const t = await shownAt(page, id);
      const r = await rec(page);
      const delta = t - r.rx[id];
      test.info().annotations.push({
        type: "P2",
        description: `showing ${i}: arrival→staged ${Math.round(delta)} ms`,
      });
      console.log(
        `[stage-e2e] P2 showing ${i} arrival→staged ${Math.round(delta)} ms`,
      );
      expect(delta).toBeLessThanOrEqual(250);
    }
    expect(tts).toHaveLength(0);

    // U4: a part signed by someone else, for this session, in this channel.
    const foreignText = `${title}: foreign injection.`;
    const foreignIds: string[] = [];
    await publishMany(
      viewerKey,
      [{ ...showing(deck, 0, foreignText, false), created_at: nextTs() }],
      foreignIds,
      VIEWER_AUTH_TAG ?? "",
    );
    await expect(page.getByTestId("stage-position")).toHaveText("3/3");
    await page.waitForTimeout(2_000);
    expect((await rec(page)).shown.some((s) => s.id === foreignIds[0])).toBe(
      false,
    );
    await expect(page.getByTestId("stage-position")).toHaveText("3/3");
    await shot(page, "05-portrait-stacked");
    // Exit with the button; the part is an ordinary row in the timeline.
    await page.getByTestId("stage-exit").click();
    await expect(view).toHaveCount(0);
    await expect(page.getByText(foreignText).first()).toBeVisible();
  });

  test("#3 Esc while a showing is speaking stops audio and releases the wake lock", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(LANDSCAPE);
    await stubNetwork(page);
    const tts: TtsCall[] = [];
    // A LONG utterance (10 s of PCM) so Esc lands mid-speech. Registered
    // AFTER stubNetwork: the most recently added route wins.
    await page.route("**/tts", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
          },
        });
        return;
      }
      tts.push({ text: route.request().postData() ?? "" });
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*" },
        body: Buffer.alloc(24_000 * 2 * 10),
      });
    });
    const channelId = await scratchChannel();
    const title = `Stage e2e esc ${run}`;
    const deck = stageOpen(channelId, true, title);
    await signIn(page, `/repos?c=${channelId}`, viewerKey, VIEWER_AUTH_TAG);
    const card = page.getByTestId("stage-open-card").filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("stage-open-button").click();
    await expect(page.getByTestId("stage-view")).toBeVisible();
    // Let the Stage's history load settle first: a showing that lands while
    // it is still loading is seeded as "late" backlog and never spoken
    // (was BUG-6, fixed in stageFeed.ts; the wait stays so this test
    // measures Esc, not the load race).
    await page.waitForTimeout(2_500);
    const id = await publishOne(agentKey, showing(deck, 0, `${title}: long.`));
    await shownAt(page, id);
    await expect
      .poll(() => rec(page).then((r) => r.sources.length), {
        timeout: 15_000,
        message: "no agent audio scheduled",
      })
      .toBeGreaterThan(0);
    await expect.poll(() => ctxStates(page)).toContain("running");
    expect((await rec(page)).wake.acquired).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("stage-view")).toHaveCount(0);
    // The speaking context is closed (not merely suspended) and the lock
    // is released.
    await expect.poll(() => ctxStates(page)).not.toContain("running");
    const r = await rec(page);
    expect(r.wake.released).toBe(r.wake.acquired);
  });

  test("#4 banner: a different author's open in the viewed DM → tap to watch", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(LANDSCAPE);
    await stubNetwork(page);
    await signIn(page, `/repos?c=${dmId}`, viewerKey, VIEWER_AUTH_TAG);
    await expect(page.getByTestId("channel-sidebar")).toBeVisible();
    await page.waitForTimeout(3_000);
    // History never raises a banner (earlier runs left opens here).
    await expect(page.getByTestId("stage-ready-banner")).toHaveCount(0);
    const title = `Stage e2e banner ${run}`;
    const deck = stageOpen(dmId, false, title);
    const banner = page.getByTestId("stage-ready-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(title);
    await page.getByTestId("stage-ready-watch").click();
    await expect(page.getByTestId("stage-view")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`stage=${deck.session}`));
    // The banner tap is a gesture: no "Tap to start" screen.
    await expect(page.getByTestId("stage-tap-to-start")).toHaveCount(0);
    await expect.poll(() => ctxStates(page)).toContain("running");
    await page.getByTestId("stage-exit").click();
    await expect(page.getByTestId("stage-view")).toHaveCount(0);
    await expect(banner).toHaveCount(0);

    // The viewer's OWN open never raises a banner.
    const ownIds: string[] = [];
    await publishMany(
      viewerKey,
      [
        {
          kind: 9,
          tags: [
            ["h", dmId],
            [
              "stage",
              JSON.stringify({
                v: 1,
                op: "open",
                title: `own ${run}`,
                voice: false,
                parts: [
                  {
                    x: deck.media[0].sha256,
                    url: deck.media[0].url,
                    m: deck.media[0].type,
                  },
                ],
              }),
            ],
          ],
          content: `own open ${run}`,
        },
      ],
      ownIds,
      VIEWER_AUTH_TAG ?? "",
    );
    await expect(page.getByText(`own open ${run}`).first())
      .toBeAttached({
        timeout: 15_000,
      })
      .catch(() => {});
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("stage-ready-banner")).toHaveCount(0);
  });

  test("#5 banner fires in a freshly created channel (only system rows before the open)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(LANDSCAPE);
    await stubNetwork(page);
    const channelId = await scratchChannel();
    await signIn(page, `/repos?c=${channelId}`, viewerKey, VIEWER_AUTH_TAG);
    await expect(page.getByTestId("channel-sidebar")).toBeVisible();
    await page.waitForTimeout(3_000);
    const title = `Stage e2e empty ${run}`;
    stageOpen(channelId, false, title);
    await expect(
      page.getByTestId("stage-open-card").filter({ hasText: title }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("stage-ready-banner")).toBeVisible({
      timeout: 5_000,
    });
  });
  // ── Defects found by this spec (2026-09-26), now fixed. Each asserts the
  //    CORRECT behaviour and was pinned `test.fail` until its fix landed. ──

  test("BUG-1 two showings posted in the same second both get staged, in post order", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(LANDSCAPE);
    await stubNetwork(page);
    const channelId = await scratchChannel();
    const title = `Stage e2e order ${run}`;
    const deck = stageOpen(channelId, false, title);
    await signIn(page, `/repos?c=${channelId}`, viewerKey, VIEWER_AUTH_TAG);
    const card = page.getByTestId("stage-open-card").filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("stage-open-button").click();
    await expect(page.getByTestId("stage-view")).toBeVisible();

    const second = nextTs();
    const firstIds: string[] = [];
    await publishMany(
      agentKey,
      [{ ...showing(deck, 0, `${title}: first.`, false), created_at: second }],
      firstIds,
    );
    await shownAt(page, firstIds[0]);
    // The agent's NEXT post lands in the same wall-clock second. Whether its
    // id sorts before or after the first is a coin flip in real life; pick
    // the losing side deterministically (vary the text until it sorts first).
    let n = 0;
    let template = showing(deck, 1, `${title}: second 0.`, false);
    while (
      finalizeEvent({ ...template, created_at: second }, agentKey).id >=
      firstIds[0]
    ) {
      n += 1;
      template = showing(deck, 1, `${title}: second ${n}.`, false);
    }
    const secondIds: string[] = [];
    await publishMany(
      agentKey,
      [{ ...template, created_at: second }],
      secondIds,
    );
    await shownAt(page, secondIds[0], 8_000);
    await expect(page.getByTestId("stage-position")).toHaveText("2/2");
  });

  test("BUG-2 portrait: a long unbreakable chat line does not push Exit off-screen", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(PORTRAIT);
    await stubNetwork(page);
    const channelId = await scratchChannel();
    // Past the channel's own system rows, so only the line below is long.
    await page.waitForTimeout(2_000);
    const title = `Stage e2e wide ${run}`;
    stageOpen(channelId, false, title);
    await publishAs(
      RELAY_WS,
      agentKey,
      [
        {
          kind: 9,
          tags: [["h", channelId]],
          content: `https://example.invalid/${"a".repeat(240)}`,
        },
      ],
      AUTH_TAG,
    );
    await signIn(page, `/repos?c=${channelId}`, viewerKey, VIEWER_AUTH_TAG);
    const card = page.getByTestId("stage-open-card").filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("stage-open-button").click();
    await expect(page.getByTestId("stage-view")).toHaveAttribute(
      "data-layout",
      "stacked",
    );
    await expect(
      page.getByTestId("stage-chat-list").getByRole("link"),
    ).toBeVisible();
    await shot(page, "06-bug2-portrait-overflow");
    const g = await geometry(page);
    const exit = await page.getByTestId("stage-exit").evaluate((el) => {
      const b = el.getBoundingClientRect();
      return b.x + b.width;
    });
    expect(must(g.chat).w).toBeLessThanOrEqual(g.vw + 1);
    expect(must(g.image).w).toBeLessThanOrEqual(g.vw + 1);
    expect(exit).toBeLessThanOrEqual(g.vw);
  });

  test("BUG-3 a system event during a Stage renders as a system row, not raw JSON", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(LANDSCAPE);
    await stubNetwork(page);
    // Channel WITHOUT the viewer; the Stage opens; THEN the viewer is added,
    // so "member joined" lands inside the session window.
    const channelId = crypto.randomUUID();
    await publishAs(
      RELAY_WS,
      agentKey,
      [
        {
          kind: 9007,
          tags: [
            ["h", channelId],
            ["name", `stage-e2e-${channelId.slice(0, 6)}`],
            ["visibility", "private"],
            ["channel_type", "stream"],
          ],
          content: "",
        },
      ],
      AUTH_TAG,
    );
    await page.waitForTimeout(1_500);
    const title = `Stage e2e sys ${run}`;
    stageOpen(channelId, false, title);
    await page.waitForTimeout(1_100);
    await publishAs(
      RELAY_WS,
      agentKey,
      [
        {
          kind: 9000,
          tags: [
            ["h", channelId],
            ["p", viewerPubkey],
          ],
          content: "",
        },
      ],
      AUTH_TAG,
    );
    await signIn(page, `/repos?c=${channelId}`, viewerKey, VIEWER_AUTH_TAG);
    const card = page.getByTestId("stage-open-card").filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("stage-open-button").click();
    const chat = page.getByTestId("stage-chat-list");
    await expect(page.getByTestId("stage-view")).toBeVisible();
    await page.waitForTimeout(2_000);
    await shot(page, "07-bug3-raw-json-row");
    await expect(chat.getByText('"type":"member_joined"')).toHaveCount(0);
  });

  test("BUG-4 exiting a Stage opened from the CARD does not bring its banner back", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(LANDSCAPE);
    await stubNetwork(page);
    await signIn(page, `/repos?c=${dmId}`, viewerKey, VIEWER_AUTH_TAG);
    await expect(page.getByTestId("channel-sidebar")).toBeVisible();
    await page.waitForTimeout(3_000);
    const title = `Stage e2e rebanner ${run}`;
    stageOpen(dmId, false, title);
    const banner = page.getByTestId("stage-ready-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await page
      .getByTestId("stage-open-card")
      .filter({ hasText: title })
      .getByTestId("stage-open-button")
      .click();
    await expect(page.getByTestId("stage-view")).toBeVisible();
    await page.getByTestId("stage-exit").click();
    await expect(page.getByTestId("stage-view")).toHaveCount(0);
    await page.waitForTimeout(1_000);
    await shot(page, "08-bug4-banner-back");
    await expect(banner).toHaveCount(0);
  });
});
