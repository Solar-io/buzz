import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { PERSONA_KIND } from "./personas.ts";
import { validateAgentDefinitionText } from "./definitionText.ts";

/**
 * Community persona catalog — the web mirror of the desktop's
 * `desktop/src-tauri/src/persona_catalog.rs` trust-boundary projection
 * (`publications_from_verified_events` + `parse_agent`).
 *
 * Catalog state is RELAY-CONFIRMED ONLY (desktop AGENTS.md rule 10): the
 * catalog renders shared kind-30175 publications exactly as the relay returns
 * them, never an optimistic local persona. The relay's shared-gate already
 * withheld every unshared event before this code ran; the tag check below is
 * the mirror of the same policy, not a second filter over foreign events.
 *
 * HEAD SELECTION — claim before visibility (the load-bearing rule): a
 * coordinate `(owner, d)` is claimed by its newest event (tie: lower event id)
 * BEFORE the shared tag or content parse is consulted. A newer unshared or
 * malformed head is still the NIP-33 head and must suppress an older shared
 * definition — never resurrect it. Moving the claim after the shared check is
 * the resurrection bug this module exists to prevent.
 *
 * Rule 12 (byte-for-byte review): every display name and system prompt passes
 * `validateAgentDefinitionText` (./definitionText.ts — the Rust rejection
 * mirror) BEFORE a publication exists. Rejected events are skipped entirely;
 * nothing is stripped, so what renders is what would execute.
 *
 * SYNC DUTY: when `persona_catalog.rs` changes, change this file and
 * `personaCatalog.test.mjs` in the same commit.
 *
 * Known mirror divergences (stated, not silent):
 * - Byte lengths use TextEncoder (Rust `str::len()` is bytes; JS `.length` is
 *   UTF-16 units — equal only for ASCII payloads).
 * - `serde_json::as_u64` rejects `4.0` (float) while `JSON.parse` cannot
 *   distinguish `4` from `4.0`; integral floats pass here. Display-only: the
 *   install builder re-gates parallelism before anything is sent.
 * - `url::Url::parse` (Rust) rejects authority-less forms like `http:example.com`
 *   that WHATWG `new URL` normalizes to `http://example.com/`. A degenerate
 *   avatar URL that slips through this branch is display-only (an <img> src)
 *   and still scheme-gated to http/https.
 */

/** Mirror of `MAX_HTTP_AVATAR_LENGTH` (persona_catalog.rs:26). */
const MAX_HTTP_AVATAR_LENGTH = 2_048;
/** Mirror of `INLINE_SVG_AVATAR_PREFIX` (persona_catalog.rs:27). */
const INLINE_SVG_AVATAR_PREFIX = "data:image/svg+xml,";
/** Mirror of `MAX_INLINE_SVG_AVATAR_LENGTH` (persona_catalog.rs:28). */
const MAX_INLINE_SVG_AVATAR_LENGTH = 8_192;
/** Mirror of `MAX_INLINE_RASTER_AVATAR_LENGTH` (persona_catalog.rs:29). */
const MAX_INLINE_RASTER_AVATAR_LENGTH = 256 * 1_024;
/** Mirror of `INLINE_RASTER_AVATAR` (persona_catalog.rs:31-33). */
const INLINE_RASTER_AVATAR =
  /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
/** Rust `char::is_whitespace` = Unicode White_Space (same set Session A used). */
const HAS_UNICODE_WHITESPACE = /\p{White_Space}/u;

/** The catalog agent projection — mirror of `CatalogAgentProjection`. */
export interface CatalogAgentProjection {
  displayName: string;
  avatarUrl: string | null;
  systemPrompt: string;
  runtime: string | null;
  model: string | null;
  provider: string | null;
  namePool: string[];
  /** "allowlist" maps to "owner-only" — foreign allowlists are meaningless. */
  respondTo: "owner-only" | "anyone" | null;
  /** Clamped 1..=32 at parse; null when absent/invalid. */
  parallelism: number | null;
}

/** One relay-confirmed shared publication — mirror of `PersonaCatalogPublication`. */
export interface CatalogPublication {
  eventId: string;
  /** Lowercased author pubkey (the coordinate owner). */
  ownerPubkey: string;
  sourcePersonaId: string;
  /** Event created_at, seconds. */
  createdAt: number;
  agent: CatalogAgentProjection;
}

/** Stable coordinate key for a publication: `ownerPubkey:personaId`. */
export function catalogCoordinateKey(
  ownerPubkey: string,
  personaId: string,
): string {
  // The owner segment is always 64 hex chars, so the first ":" split is
  // unambiguous even when a persona id contains ":".
  return `${ownerPubkey.toLowerCase()}:${personaId}`;
}

/**
 * The value of the single tag named `name`, when exactly one such tag exists
 * with at least two values — mirror of `coordinate_tag` (persona_catalog.rs).
 * Zero or several matching tags → null.
 */
function coordinateTag(event: SignedNostrEvent, name: string): string | null {
  const matches = event.tags
    .filter(
      (tag) => tag.length >= 2 && tag[0] === name && typeof tag[1] === "string",
    )
    .map((tag) => tag[1]);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The value of the single tag named `name` whose values are EXACTLY
 * `["name", value]` — mirror of `exact_tag`. `["shared","true","extra"]` does
 * not count, and neither does a duplicate. Zero or several → null.
 */
function exactTag(event: SignedNostrEvent, name: string): string | null {
  const matches = event.tags
    .filter((tag) => tag.length === 2 && tag[0] === name)
    .map((tag) => tag[1]);
  return matches.length === 1 ? matches[0] : null;
}

/** Mirror of `parse_agent` — null means the event contributes nothing. */
export function parseCatalogAgent(
  content: string,
): CatalogAgentProjection | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.display_name !== "string") {
    return null;
  }
  const displayName = object.display_name;
  const systemPrompt =
    typeof object.system_prompt === "string" ? object.system_prompt : "";

  // Rule-12 gate BEFORE anything renders or installs. Rejected ⇒ skipped.
  if (!validateAgentDefinitionText(displayName, systemPrompt).ok) {
    return null;
  }

  let respondTo: CatalogAgentProjection["respondTo"] = null;
  if (object.respond_to === "allowlist") {
    respondTo = "owner-only";
  } else if (
    object.respond_to === "owner-only" ||
    object.respond_to === "anyone"
  ) {
    respondTo = object.respond_to;
  }

  const parallelismValue = object.parallelism;
  const parallelism =
    typeof parallelismValue === "number" &&
    Number.isInteger(parallelismValue) &&
    parallelismValue >= 1 &&
    parallelismValue <= 32
      ? parallelismValue
      : null;

  const namePool = Array.isArray(object.name_pool)
    ? object.name_pool.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  return {
    displayName,
    avatarUrl:
      typeof object.avatar_url === "string" && safeAvatar(object.avatar_url)
        ? object.avatar_url
        : null,
    systemPrompt,
    runtime: optionalString(object.runtime),
    model: optionalString(object.model),
    provider: optionalString(object.provider),
    namePool,
    respondTo,
    parallelism,
  };
}

/** Mirror of `optional_string`: string with a non-blank trim, else null. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const textEncoder = new TextEncoder();

/** Byte length of `value` — mirrors Rust `str::len()`. */
function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * Mirror of `safe_avatar` (persona_catalog.rs:272-292), branch for branch:
 * inline SVG prefix → length cap; base64 raster → total cap + payload regex +
 * len%4==0; anything else → http(s) URL, ≤2048 bytes, no whitespace, no
 * parens. REJECT is the only failure mode — nothing is sanitized in place.
 */
export function safeAvatar(value: string): boolean {
  if (value.startsWith(INLINE_SVG_AVATAR_PREFIX)) {
    return byteLength(value) <= MAX_INLINE_SVG_AVATAR_LENGTH;
  }
  if (byteLength(value) <= MAX_INLINE_RASTER_AVATAR_LENGTH) {
    const captures = INLINE_RASTER_AVATAR.exec(value);
    if (captures !== null) {
      // Payload charset is ASCII, so .length == byte length here.
      return captures[1].length % 4 === 0;
    }
  }
  if (
    byteLength(value) > MAX_HTTP_AVATAR_LENGTH ||
    HAS_UNICODE_WHITESPACE.test(value) ||
    value.includes("(") ||
    value.includes(")")
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Mirror of `publications_from_verified_events`: newest-first sort (tie: lower
 * event id), claim the `(owner, d)` coordinate BEFORE the shared check or the
 * content parse, then require exactly-one `["shared","true"]` tag and a
 * rule-12-clean parseable projection. Input events are assumed
 * signature-verified (the hook verifies; the desktop verifies per page).
 */
export function publicationsFromVerifiedEvents(
  events: Iterable<SignedNostrEvent>,
): CatalogPublication[] {
  const sorted = [...events].sort(
    (left, right) =>
      right.created_at - left.created_at || (left.id < right.id ? -1 : 1),
  );
  const claimed = new Set<string>();
  const publications: CatalogPublication[] = [];

  for (const event of sorted) {
    if (event.kind !== PERSONA_KIND) {
      continue;
    }
    const sourcePersonaId = coordinateTag(event, "d");
    if (sourcePersonaId === null || sourcePersonaId === "") {
      continue;
    }
    const ownerPubkey = event.pubkey.toLowerCase();
    const coordinate = catalogCoordinateKey(ownerPubkey, sourcePersonaId);
    if (claimed.has(coordinate)) {
      continue;
    }
    // Claim happens before visibility or parsing. A valid newest unshared or
    // malformed head is still the NIP-33 head and must not resurrect an older
    // shared definition (persona_catalog.rs:170-173).
    claimed.add(coordinate);

    if (exactTag(event, "shared") !== "true") {
      continue;
    }
    const agent = parseCatalogAgent(event.content);
    if (agent === null) {
      continue;
    }
    publications.push({
      eventId: event.id,
      ownerPubkey,
      sourcePersonaId,
      createdAt: event.created_at,
      agent,
    });
  }
  return publications;
}

/**
 * Newest-head accumulation for a live subscription: dedupe by event id (a
 * replaceable republish arrives as a NEW event; the same id is the same
 * event). The hook keeps this raw set and re-derives publications from it, so
 * a late-arriving unshared newest head still suppresses the older shared one
 * exactly as `publicationsFromVerifiedEvents` prescribes.
 */
export function mergeVerifiedCatalogEvent(
  events: ReadonlyMap<string, SignedNostrEvent>,
  event: SignedNostrEvent,
): Map<string, SignedNostrEvent> {
  // Same id = same signed event; reference-stable no-op keeps re-renders cheap.
  if (events.has(event.id)) {
    return events as Map<string, SignedNostrEvent>;
  }
  const next = new Map(events);
  next.set(event.id, event);
  return next;
}

/** Publications keyed by coordinate — the hook's lookup surface. */
export function catalogPublicationsByKey(
  publications: readonly CatalogPublication[],
): Map<string, CatalogPublication> {
  const byKey = new Map<string, CatalogPublication>();
  for (const publication of publications) {
    byKey.set(
      catalogCoordinateKey(
        publication.ownerPubkey,
        publication.sourcePersonaId,
      ),
      publication,
    );
  }
  return byKey;
}
