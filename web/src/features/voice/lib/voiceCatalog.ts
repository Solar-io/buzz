/**
 * Buzz voice catalog (kind 30181) — the wire format, read off the Rust rather
 * than guessed.
 *
 * Source of truth, in order:
 *
 *  - `crates/buzz-core/src/kind.rs` — `KIND_VOICE_CATALOG: u32 = 30181`,
 *    "one event per voice, addressed by `(pubkey, kind, d_tag)` where
 *    `d_tag` is the voice key verbatim … community-global … readable by any
 *    authenticated member — the same read model as 30177/30180". It carries
 *    NO `h` tag (global-only kind; `is_global_only_kind` in the relay's
 *    ingest), so a REQ with explicit `kinds` is community-readable by any
 *    member (the p-gate only closes filters over gated kinds).
 *  - `docs/plans/2026-09-15-voice-repository-v1.md` §3 — the versioned JSON
 *    body mirrored by the desktop reader
 *    (`desktop/src-tauri/src/huddle/voice_catalog.rs`), camelCase fields,
 *    optional fields absent when null.
 *
 * Web reads fold raw events by `d` (last write wins). On web there is no
 * local voice registry to shadow a forged `pocket:eve` row, so the reader is
 * the only guard: eve rows are dropped at parse.
 */

/** Buzz voice catalog. `crates/buzz-core/src/kind.rs`. */
export const KIND_VOICE_CATALOG = 30181;

/** The one voice key banned from catalog publication (identity-test ban). */
export const EVE_VOICE_KEY = "pocket:eve";

/** sha256 + size locator; the URL is `{relay-http-base}/media/{sha256}.wav`. */
export interface VoiceCatalogAsset {
  sha256: string;
  size: number;
  mimeType: string;
}

/** The JSON body of a kind:30181 event, mirroring the desktop's reader. */
export interface VoiceCatalogContent {
  version: number;
  key: string;
  displayName: string;
  backend: string;
  contentHash: string;
  bundled: boolean;
  license: string;
  source: string;
  sourceUrl?: string | null;
  asset?: VoiceCatalogAsset | null;
  sampleRate?: number | null;
  durationSeconds?: number | null;
}

/** One validated catalog row with its event provenance. */
export interface VoiceCatalogRow {
  /** Author pubkey (hex) — coordinates never collide across authors. */
  pubkey: string;
  /** The event's `created_at`, unix seconds — LWW within a coordinate. */
  createdAt: number;
  content: VoiceCatalogContent;
}

/** The subset of a signed event this module reads. */
export interface CatalogEventLike {
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

function tagValues(tags: string[][], name: string): string[] {
  const values: string[] = [];
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") {
      values.push(tag[1]);
    }
  }
  return values;
}

function isLowercaseHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/.test(value);
}

/**
 * The voice-key grammar (design §3.3): `pocket:<slug>` or
 * `pocket:imported:<64 lowercase hex>` with the imported form required to
 * equal `pocket:imported:` + `contentHash` (the Rust `valid_identity` rule).
 */
function isValidVoiceKey(content: VoiceCatalogContent): boolean {
  const importedPrefix = "pocket:imported:";
  if (content.key.startsWith(importedPrefix)) {
    const hash = content.key.slice(importedPrefix.length);
    return isLowercaseHex(hash, 64) && hash === content.contentHash;
  }
  const bundledPrefix = "pocket:";
  if (content.key.startsWith(bundledPrefix)) {
    const slug = content.key.slice(bundledPrefix.length);
    return slug !== "" && /^[a-z0-9_-]+$/.test(slug);
  }
  return false;
}

/**
 * Read one kind:30181 event. Returns `null` for anything the reader refuses:
 * unparseable content, a future `version`, a key that does not equal the
 * event's `d` tag, a key violating the grammar, or the banned `pocket:eve`
 * key — on web there is no local registry to shadow that row, so the reader
 * is the only guard.
 */
export function parseVoiceCatalogEvent(
  event: CatalogEventLike,
): VoiceCatalogRow | null {
  let content: VoiceCatalogContent;
  try {
    content = JSON.parse(event.content) as VoiceCatalogContent;
  } catch {
    return null;
  }
  if (
    content === null ||
    typeof content !== "object" ||
    typeof content.version !== "number" ||
    typeof content.key !== "string"
  ) {
    return null;
  }
  if (content.version > 1) {
    return null;
  }
  const dTags = tagValues(event.tags, "d");
  if (dTags.length !== 1 || dTags[0] !== content.key) {
    return null;
  }
  if (!isValidVoiceKey(content)) {
    return null;
  }
  if (content.key === EVE_VOICE_KEY) {
    return null;
  }
  return { pubkey: event.pubkey, createdAt: event.created_at, content };
}

/**
 * Fold a stream of catalog events into one row per voice key.
 *
 * Newer `created_at` wins, matching NIP-33 replacement — the relay replaces
 * server-side, but a live subscription plus a historical replay can deliver
 * both an old and a new event, in either order. Rows the parser refuses are
 * dropped, not fatal.
 */
export function reduceVoiceCatalogEvents(
  events: readonly CatalogEventLike[],
): Map<string, VoiceCatalogRow> {
  const rows = new Map<string, VoiceCatalogRow>();
  for (const event of events) {
    const row = parseVoiceCatalogEvent(event);
    if (row === null) {
      continue;
    }
    const existing = rows.get(row.content.key);
    if (existing && existing.createdAt >= row.createdAt) {
      continue;
    }
    rows.set(row.content.key, row);
  }
  return rows;
}

/**
 * Derive the asset URL from a row: the sha256 is authoritative, the URL is
 * `{relay-http-base}/media/{sha256}.wav` (v1 fixes the `.wav` extension —
 * only canonical WAV is uploadable). Null for bundled rows, which have no
 * asset.
 */
export function assetUrl(
  row: VoiceCatalogRow,
  relayHttpBase: string,
): string | null {
  return row.content.asset
    ? `${relayHttpBase}/media/${row.content.asset.sha256}.wav`
    : null;
}
