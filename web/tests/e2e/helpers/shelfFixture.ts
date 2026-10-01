import { deflateSync } from "node:zlib";

import type { Page } from "@playwright/test";

import { hexId, type MockEvent, mockEvent } from "./mockRelay";
import type { WorkFixture } from "./workFixture";

/**
 * Shares (`buzz share`, web redesign Phase 6) for the Shelf, the file tabs
 * and the message tiles, faked at the relay boundary — shaped exactly as
 * phase-6.md's wire format: a kind 9 with one `imeta` per file (filename
 * last), `["t","shelf"]`, then one `["path","crichton:<abs>"]` per file.
 *
 * The bytes behind each URL are served by {@link routeShelfMedia}: the
 * previewers fetch them through the real signed-GET path, so a broken fetch,
 * decode or sandbox shows up here rather than only live.
 */

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
/** The preview server's origin: relay media is same-origin in the e2e build. */
export const MEDIA_ORIGIN = `http://127.0.0.1:${PORT}`;
const HOME = "/Users/sgallant";
export const RTS_DIR = `${HOME}/MEGA/shared_files/dropbox/rts-bakeoff`;

export interface ShelfFile {
  name: string;
  mime: string;
  body: Buffer;
}

function sha(seed: string): string {
  let hash = 0;
  let out = "";
  for (let round = 0; out.length < 64; round += 1) {
    for (const character of `${seed}:${round}`) {
      hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

export function mediaUrl(name: string): string {
  const ext = name.endsWith(".png") ? "png" : "bin";
  return `${MEDIA_ORIGIN}/media/${sha(name)}.${ext}`;
}

// ---- a real PNG (a warm gradient), so the image previewer decodes bytes ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
export function gradientPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const t = x / width;
      const s = y / height;
      row[1 + x * 3] = Math.round(235 - 60 * s);
      row[2 + x * 3] = Math.round(162 + 50 * t - 40 * s);
      row[3 + x * 3] = Math.round(26 + 120 * t * s);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const RESULTS_MD = `# RTS bake-off: results

Four one-shot Command & Conquer clones, one per model config, played blind and scored 1–5.

| Game | Model | Score | Build |
|---|---|---:|---:|
| C | Sol max | 5 | 32 min |
| D | Opus xhigh | 4 | 56 min |
| B | Opus high | 2 | 31 min |
| A | Sol high | 1 | 28 min |

## Takeaways

The task picks the winner. Top effort decided both creative rounds, while on the graded suites it bought nothing.
`;

const GAME_HTML = (letter: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>game-${letter}</title>
<style>
  html,body{margin:0;height:100%;background:#1b1a16;color:#f6f1e4;font:13px ui-monospace,Menlo,monospace}
  #hud{position:absolute;top:8px;left:10px}
  canvas{display:block;width:100%;height:100%}
</style></head>
<body><div id="hud">game-${letter} · <span id="state">booting</span></div><canvas id="c"></canvas>
<script>
  const c = document.getElementById("c");
  const x = c.getContext("2d");
  c.width = 640; c.height = 400;
  for (let i = 0; i < 40; i++) {
    x.fillStyle = i % 3 ? "#2e9a68" : "#eba21a";
    x.fillRect((i * 97) % 600, (i * 53) % 360, 14, 14);
  }
  document.getElementById("state").textContent = "running";
</script></body></html>`;

/**
 * The isolation probe: run inside the preview frame, try every way to reach
 * this app's storage and cookies, and report to the parent. Each read is
 * expected to THROW (opaque origin) — a value coming back is the failure.
 */
export const PROBE_HTML = `<!doctype html><html><body><p id="out">probing</p>
<script>
  const out = { origin: String(self.origin) };
  const tryRead = (name, read) => {
    try { out[name] = String(read()); } catch (error) { out[name] = "blocked:" + error.name; }
  };
  tryRead("localStorage", () => localStorage.getItem("buzz-e2e-secret"));
  tryRead("sessionStorage", () => sessionStorage.getItem("buzz-e2e-secret"));
  tryRead("cookie", () => document.cookie);
  tryRead("parentLocalStorage", () => parent.localStorage.getItem("buzz-e2e-secret"));
  tryRead("parentCookie", () => parent.document.cookie);
  tryRead("parentTitle", () => parent.document.title);
  tryRead("indexedDB", () => indexedDB.open("buzz-e2e-probe") && "opened");
  document.getElementById("out").textContent = "probed";
  parent.postMessage({ type: "buzz-e2e-probe", out }, "*");
</script></body></html>`;

/** One page that says "Capture plan" — enough for the browser's viewer. */
const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 70 Td (Capture plan) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

const TRACE_JSON = `${JSON.stringify(
  {
    huddle: "beat-02",
    stalls: [
      { at: "00:12:04.220", ms: 412, buffer: "jitter", peer: "esp32" },
      { at: "00:27:51.031", ms: 388, buffer: "jitter", peer: "esp32" },
    ],
    verdict: "underflow when the peer drops below 22 kbps",
  },
  null,
  2,
)}\n`;

const DELETE_CSV = `snapshot,host,age_days,size_gb
pilot-2026-08-01,pilot,60,41.2
pilot-2026-08-15,pilot,46,40.8
"pilot-2026-08-29, pre-upgrade",pilot,32,43.0
`;

export const SHELF_FILES: Record<string, ShelfFile> = {
  "bakeoff-results.md": {
    name: "bakeoff-results.md",
    mime: "application/octet-stream",
    body: Buffer.from(RESULTS_MD),
  },
  ...Object.fromEntries(
    ["A", "B", "C", "D"].map((letter) => [
      `game-${letter}.html`,
      {
        name: `game-${letter}.html`,
        mime: "application/octet-stream",
        body: Buffer.from(GAME_HTML(letter)),
      },
    ]),
  ),
  "beat-02-capture.png": {
    name: "beat-02-capture.png",
    mime: "image/png",
    body: gradientPng(320, 180),
  },
  "jitter-buffer-trace.json": {
    name: "jitter-buffer-trace.json",
    mime: "application/json",
    body: Buffer.from(TRACE_JSON),
  },
  "project-inventory.md": {
    name: "project-inventory.md",
    mime: "application/octet-stream",
    body: Buffer.from("# Project inventory\n\n106 folders, tiered.\n"),
  },
  "design-bakeoff-blind.html": {
    name: "design-bakeoff-blind.html",
    mime: "application/octet-stream",
    body: Buffer.from(GAME_HTML("blind")),
  },
  "pilot-snapshots-delete-list.csv": {
    name: "pilot-snapshots-delete-list.csv",
    mime: "text/csv",
    body: Buffer.from(DELETE_CSV),
  },
  "capture-plan.pdf": {
    name: "capture-plan.pdf",
    mime: "application/pdf",
    body: Buffer.from(MINIMAL_PDF),
  },
  "storage-probe.html": {
    name: "storage-probe.html",
    mime: "application/octet-stream",
    body: Buffer.from(PROBE_HTML),
  },
};

/** Serve every shared file's bytes at its media URL (the signed GET). */
export async function routeShelfMedia(page: Page): Promise<string[]> {
  const fetched: string[] = [];
  const byUrl = new Map(
    Object.values(SHELF_FILES).map((file) => [mediaUrl(file.name), file]),
  );
  await page.route(`${MEDIA_ORIGIN}/media/**`, async (route) => {
    const file = byUrl.get(route.request().url());
    if (!file) {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    fetched.push(file.name);
    await route.fulfill({
      status: 200,
      contentType: file.mime,
      body: file.body,
      headers: {
        // What the relay sends for a generic file (phase-6 D6.4).
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
      },
    });
  });
  return fetched;
}

let seq = 0;

/** One `buzz share`, tags in the CLI's order. */
export function shareEvent(input: {
  author: string;
  channel: string;
  createdAt: number;
  summary: string;
  files: string[];
  paths?: boolean;
  dir?: string;
}): MockEvent {
  seq += 1;
  const files = input.files.map((name) => SHELF_FILES[name]);
  const lines = files.map((file) =>
    file.mime.startsWith("image/")
      ? `![image](${mediaUrl(file.name)})`
      : `[${file.name}](${mediaUrl(file.name)})`,
  );
  const tags: string[][] = [["h", input.channel]];
  for (const file of files) {
    tags.push([
      "imeta",
      `url ${mediaUrl(file.name)}`,
      `m ${file.mime}`,
      `x ${sha(file.name)}`,
      `size ${file.body.length}`,
      ...(file.mime === "image/png" ? ["dim 320x180"] : []),
      `filename ${file.name}`,
    ]);
  }
  tags.push(["t", "shelf"]);
  if (input.paths !== false) {
    for (const file of files) {
      tags.push(["path", `crichton:${input.dir ?? RTS_DIR}/${file.name}`]);
    }
  }
  return mockEvent({
    id: hexId(seq, "5"),
    pubkey: input.author,
    created_at: input.createdAt,
    kind: 9,
    tags,
    content: [input.summary, ...lines].filter(Boolean).join("\n"),
  });
}

/** Local seconds `daysAgo` days back at a wall-clock time. */
function localAt(daysAgo: number, hour: number, minute: number): number {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/**
 * The Shelf artboard's rows: four today, four yesterday, across DMs and
 * channels, plus a comment (on a highlight) with the agent's answer.
 */
export function shelfEvents(fixture: WorkFixture): {
  events: MockEvent[];
  results: MockEvent;
  games: MockEvent;
} {
  const { agents, channels: c, viewer } = fixture;
  const now = new Date();
  // Today's rows must still be "today": anchor them before now.
  const minutesToday = now.getHours() * 60 + now.getMinutes();
  const today = (minutesAgo: number) =>
    Math.floor(Date.now() / 1000) - Math.min(minutesAgo, minutesToday - 1) * 60;
  const games = shareEvent({
    author: agents.gilfoyle.pubkey,
    channel: c["dm-gilfoyle"],
    createdAt: today(30),
    summary: "All 4 Command & Conquer clones are done and playable.",
    files: ["game-A.html", "game-B.html", "game-C.html", "game-D.html"],
  });
  const results = shareEvent({
    author: agents.gilfoyle.pubkey,
    channel: c["dm-gilfoyle"],
    createdAt: today(4),
    summary: "Scores, winner and takeaways for the RTS build",
    files: ["bakeoff-results.md"],
  });
  const capture = shareEvent({
    author: agents.nikon.pubkey,
    channel: c["flight-path"],
    createdAt: today(50),
    summary: "Project header settle, second take",
    files: ["beat-02-capture.png"],
    dir: `${HOME}/captures`,
  });
  const trace = shareEvent({
    author: agents.acid.pubkey,
    channel: c.engineering,
    createdAt: today(70),
    summary: "40-minute huddle trace behind the stall bug",
    files: ["jitter-buffer-trace.json"],
    paths: false,
  });
  const inventory = shareEvent({
    author: agents.gilfoyle.pubkey,
    channel: c["dm-gilfoyle"],
    createdAt: localAt(1, 16, 12),
    summary: "106 folders with proposed tiers and delete candidates",
    files: ["project-inventory.md"],
    dir: `${HOME}/MEGA`,
  });
  const blind = shareEvent({
    author: agents.gilfoyle.pubkey,
    channel: c.design,
    createdAt: localAt(1, 14, 40),
    summary: "6 apps × 4 models, blind review page",
    files: ["design-bakeoff-blind.html"],
  });
  const snapshots = shareEvent({
    author: agents.gilfoyle.pubkey,
    channel: c.ops,
    createdAt: localAt(1, 9, 5),
    summary: "Snapshots older than 30 days, waiting on approval",
    files: ["pilot-snapshots-delete-list.csv"],
    paths: false,
  });
  // A note on a highlight, and the agent's answer to it (a reply to the note).
  const note = mockEvent({
    id: hexId(900, "5"),
    pubkey: viewer,
    created_at: results.created_at + 120,
    kind: 9,
    tags: [
      ["h", c["dm-gilfoyle"]],
      ["e", results.id, "", "reply"],
      ["p", agents.gilfoyle.pubkey],
    ],
    content:
      "> Top effort decided both creative rounds\n\nRe-run C with audio on before 10/8.",
  });
  const answer = mockEvent({
    id: hexId(901, "5"),
    pubkey: agents.gilfoyle.pubkey,
    created_at: results.created_at + 150,
    kind: 9,
    tags: [
      ["h", c["dm-gilfoyle"]],
      ["e", results.id, "", "root"],
      ["e", note.id, "", "reply"],
    ],
    content: "On it. Added to Items, running tonight.",
  });
  return {
    events: [
      games,
      results,
      capture,
      trace,
      inventory,
      blind,
      snapshots,
      note,
      answer,
    ],
    results,
    games,
  };
}

/** The probe share, for the isolation test. */
/** A PDF share, for the previewer pass (kept out of the artboard rows). */
export function pdfShare(fixture: WorkFixture): MockEvent {
  return shareEvent({
    author: fixture.agents.nikon.pubkey,
    channel: fixture.channels["flight-path"],
    createdAt: Math.floor(Date.now() / 1000) - 90,
    summary: "Three beats, one page",
    files: ["capture-plan.pdf"],
  });
}

/**
 * The #flight-path channel canvas (kind 40100, `buzz canvas set`): one
 * `h`-scoped event whose content is the markdown. An older set sits behind
 * it so the client must take the NEWEST, not the first served.
 */
export function channelCanvasEvents(fixture: WorkFixture): MockEvent[] {
  const channel = fixture.channels["flight-path"];
  const now = Math.floor(Date.now() / 1000);
  return [
    mockEvent({
      id: hexId(40_101),
      kind: 40100,
      pubkey: fixture.agents.nikon.pubkey,
      created_at: now - 2 * 3600,
      tags: [["h", channel]],
      content: "# Flight path (stale)\n\nThis set was replaced.",
    }),
    mockEvent({
      id: hexId(40_102),
      kind: 40100,
      pubkey: fixture.agents.nikon.pubkey,
      created_at: now - 20 * 60,
      tags: [["h", channel]],
      content: [
        "# Flight path",
        "",
        "The capture plan for the launch video: three beats, one take each.",
        "",
        "## Beats",
        "",
        "1. **Header settle** — the project header lands and holds 2 s.",
        "2. **Work rail** — a running turn, then Done today.",
        "3. **Canvas** — a shared PDF opens beside the chat.",
        "",
        "> [!NOTE]",
        "> Beat 02 is captured; the second take is on the Shelf.",
      ].join("\n"),
    }),
  ];
}

export function probeShare(fixture: WorkFixture): MockEvent {
  return shareEvent({
    author: fixture.agents.gilfoyle.pubkey,
    channel: fixture.channels["dm-gilfoyle"],
    createdAt: Math.floor(Date.now() / 1000) - 60,
    summary: "Isolation probe",
    files: ["storage-probe.html"],
  });
}
