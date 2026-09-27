/**
 * Agent Stage Mode wire contract — the `["stage", "<compact JSON>"]` tag on
 * kind-9 messages (design: `~/.buzz/PLANS/AGENT_STAGE_MODE_DESIGN_2026-09-26.md`
 * §4.2 as amended by §15).
 *
 * Three ops share one tag name:
 * - `open`  — one per session; `parts[]` is the PALETTE (frames available),
 *             not the show length. Session id = the open event's id.
 * - `part`  — one SHOWING of palette frame `i`. `hold` (absent = true) says
 *             whether the viewer's pacer waits for the previous showing.
 * - `close` — ends the session early.
 *
 * The Rust mirror is `crates/buzz-cli/src/commands/stage_tag.rs`. Both are
 * executed against `test-fixtures/stage-mode/{cases,limits}.json`, so a rule
 * changed on one side only turns exactly one suite red.
 *
 * Built-ins drift between the two languages (repo AGENTS.md, decision-card
 * lesson), so every type rule here is declared explicitly rather than
 * inherited from `JSON.parse`:
 * - Numbers: every number literal ANYWHERE in the tag must be spelled as a
 *   plain non-negative integer (`0` or `[1-9][0-9]*`). `JSON.parse` turns
 *   `1.0` / `1e0` into `1`, which serde's `as_u64` refuses — so this side
 *   scans the raw text (`hasNonPlainNumber`), and the Rust side runs the same
 *   scanner. Applies to ignored keys too, or the two would disagree there.
 * - Booleans: `voice` / `hold` must be JSON `true`/`false` (never `0`, `"false"`).
 * - Whitespace: a title is blank when every char is one of ` \t\n\r` — an
 *   explicit set, not `trim()` (JS and Rust trim different characters).
 * - Lengths: UTF-16 code units (JS `.length`; Rust `encode_utf16().count()`).
 * - Lone surrogates: serde_json refuses to decode them, so this side refuses
 *   them too, under the same "invalid stage JSON" reason.
 */

export const STAGE_LIMITS = {
  maxTagUnits: 8192,
  maxTitleChars: 120,
  maxParts: 50,
  maxUrlChars: 2048,
} as const;

export type StagePaletteEntry = {
  /** sha256 of the blob, 64 lowercase hex. */
  x: string;
  url: string;
  /** MIME type; always `image/*`. */
  m: string;
  dim?: string;
};

export type StageOpenTag = {
  v: 1;
  op: "open";
  title: string;
  voice: boolean;
  parts: StagePaletteEntry[];
};

export type StagePartTag = {
  v: 1;
  op: "part";
  /** The open event's id. */
  s: string;
  /** Palette index. The `< total` check needs the open event (reducer). */
  i: number;
  /** Absent on the wire means true. Always materialized after parsing. */
  hold: boolean;
};

export type StageCloseTag = { v: 1; op: "close"; s: string };

export type StageTag = StageOpenTag | StagePartTag | StageCloseTag;

export type StageParseResult =
  | { ok: true; tag: StageTag }
  | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const DIM = /^[1-9][0-9]{0,5}x[1-9][0-9]{0,5}$/;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isBlank(value: string): boolean {
  for (const ch of value) {
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return false;
  }
  return true;
}

/**
 * True when any number literal outside a string is not a plain non-negative
 * integer. Mirrors `has_non_plain_number` in stage_tag.rs character for
 * character. Only called on text `JSON.parse` already accepted, so the
 * tokenizer can be minimal.
 */
export function hasNonPlainNumber(raw: string): boolean {
  let inString = false;
  let index = 0;
  while (index < raw.length) {
    const ch = raw[index];
    if (inString) {
      if (ch === "\\") index += 2;
      else {
        if (ch === '"') inString = false;
        index += 1;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let end = index;
      while (end < raw.length && /[-+0-9.eE]/.test(raw[end])) end += 1;
      const token = raw.slice(index, end);
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return true;
      index = end;
      continue;
    }
    index += 1;
  }
  return false;
}

function fail(reason: string): StageParseResult {
  return { ok: false, reason };
}

function readBool(
  obj: Record<string, unknown>,
  key: "voice" | "hold",
): boolean | string {
  const value = obj[key];
  if (value === undefined) return true;
  if (typeof value !== "boolean") return `${key} must be a boolean`;
  return value;
}

function readSession(obj: Record<string, unknown>): string | null {
  return typeof obj.s === "string" && HEX64.test(obj.s) ? obj.s : null;
}

function parsePalette(raw: unknown): StagePaletteEntry[] | { reason: string } {
  if (!Array.isArray(raw)) return { reason: "parts must be an array" };
  if (raw.length === 0) return { reason: "open needs at least one part" };
  if (raw.length > STAGE_LIMITS.maxParts) {
    return { reason: `too many parts (max ${STAGE_LIMITS.maxParts})` };
  }
  const out: StagePaletteEntry[] = [];
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { reason: `parts[${index}] must be an object` };
    }
    const row = item as Record<string, unknown>;
    if (typeof row.x !== "string" || !HEX64.test(row.x)) {
      return { reason: `parts[${index}].x must be 64 lowercase hex` };
    }
    if (
      typeof row.url !== "string" ||
      !(row.url.startsWith("https://") || row.url.startsWith("http://")) ||
      row.url.length > STAGE_LIMITS.maxUrlChars
    ) {
      return {
        reason: `parts[${index}].url must be an http(s) URL of at most ${STAGE_LIMITS.maxUrlChars} chars`,
      };
    }
    if (
      typeof row.m !== "string" ||
      !row.m.startsWith("image/") ||
      row.m.length > 100
    ) {
      return { reason: `parts[${index}].m must be an image/* MIME type` };
    }
    const entry: StagePaletteEntry = { x: row.x, url: row.url, m: row.m };
    if (row.dim !== undefined) {
      if (typeof row.dim !== "string" || !DIM.test(row.dim)) {
        return { reason: `parts[${index}].dim must be <width>x<height>` };
      }
      entry.dim = row.dim;
    }
    out.push(entry);
  }
  return out;
}

/** Validate one raw `stage` tag value. Never throws. */
export function parseStagePayload(raw: string): StageParseResult {
  if (typeof raw !== "string") return fail("invalid stage JSON: not text");
  if (raw.length > STAGE_LIMITS.maxTagUnits) {
    return fail(
      `stage tag exceeds ${STAGE_LIMITS.maxTagUnits} UTF-16 units (${raw.length})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail(`invalid stage JSON: ${(error as Error).message}`);
  }
  if (containsLoneSurrogate(parsed)) {
    return fail("invalid stage JSON: lone surrogate");
  }
  if (hasNonPlainNumber(raw)) {
    return fail("every number must be a plain non-negative integer");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("stage tag must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) return fail("unsupported version (only v=1)");

  switch (obj.op) {
    case "open": {
      if (
        typeof obj.title !== "string" ||
        isBlank(obj.title) ||
        obj.title.length > STAGE_LIMITS.maxTitleChars
      ) {
        return fail(
          `title must be 1-${STAGE_LIMITS.maxTitleChars} UTF-16 units and not blank`,
        );
      }
      const voice = readBool(obj, "voice");
      if (typeof voice === "string") return fail(voice);
      const parts = parsePalette(obj.parts);
      if (!Array.isArray(parts)) return fail(parts.reason);
      return {
        ok: true,
        tag: { v: 1, op: "open", title: obj.title, voice, parts },
      };
    }
    case "part": {
      const s = readSession(obj);
      if (!s) return fail("s must be the open event id (64 lowercase hex)");
      if (
        typeof obj.i !== "number" ||
        !Number.isInteger(obj.i) ||
        obj.i < 0 ||
        obj.i >= STAGE_LIMITS.maxParts
      ) {
        return fail(`i must be an integer in [0, ${STAGE_LIMITS.maxParts})`);
      }
      const hold = readBool(obj, "hold");
      if (typeof hold === "string") return fail(hold);
      return { ok: true, tag: { v: 1, op: "part", s, i: obj.i, hold } };
    }
    case "close": {
      const s = readSession(obj);
      if (!s) return fail("s must be the open event id (64 lowercase hex)");
      return { ok: true, tag: { v: 1, op: "close", s } };
    }
    default:
      return fail("unknown op (expected open, part or close)");
  }
}

function containsLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") return LONE_SURROGATE.test(value);
  if (Array.isArray(value)) return value.some(containsLoneSurrogate);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, inner]) =>
        LONE_SURROGATE.test(key) || containsLoneSurrogate(inner),
    );
  }
  return false;
}

/**
 * The first valid `stage` tag on an event, or null. Malformed tags degrade to
 * plain rendering — never a broken Stage.
 */
export function parseStageTag(
  tags: readonly (readonly string[])[],
): StageTag | null {
  for (const tag of tags) {
    if (tag?.[0] !== "stage" || typeof tag[1] !== "string") continue;
    const result = parseStagePayload(tag[1]);
    return result.ok ? result.tag : null;
  }
  return null;
}

/** Canonical wire object: known keys only; `hold` omitted when true. */
function canonicalObject(tag: StageTag): Record<string, unknown> {
  switch (tag.op) {
    case "open":
      return {
        v: 1,
        op: "open",
        title: tag.title,
        voice: tag.voice,
        parts: tag.parts.map((p) =>
          p.dim === undefined
            ? { x: p.x, url: p.url, m: p.m }
            : { x: p.x, url: p.url, m: p.m, dim: p.dim },
        ),
      };
    case "part":
      return tag.hold
        ? { v: 1, op: "part", s: tag.s, i: tag.i }
        : { v: 1, op: "part", s: tag.s, i: tag.i, hold: false };
    case "close":
      return { v: 1, op: "close", s: tag.s };
  }
}

/**
 * Build the `["stage", json]` tag. Throws when the result would not parse —
 * the builder never emits what the parser refuses.
 */
export function buildStageTag(tag: StageTag): [string, string] {
  const json = JSON.stringify(canonicalObject(tag));
  const check = parseStagePayload(json);
  if (!check.ok) throw new Error(check.reason);
  return ["stage", json];
}
