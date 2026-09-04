import * as nip44 from "nostr-tools/nip44";
import { verifiedSymbol, verifyEvent } from "nostr-tools/pure";

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

import { parseStrictJson } from "./strictJson.ts";

/**
 * NIP-AE Agent Engrams — browser-side parse + decrypt.
 *
 * Port of the primitives in `crates/buzz-core/src/engram.rs` plus the
 * grouping/head-selection the desktop does inside the `get_agent_memory`
 * Tauri command (`desktop/src-tauri/src/commands/engrams.rs`). The web
 * client has no Tauri bridge, so it does the same work against the relay
 * directly. That is possible without any relay change because:
 *
 *   1. Engrams are ordinary stored `kind:30174` events.
 *   2. Every engram is `#p`-tagged to the OWNER and NIP-44 encrypted under
 *      the agent↔owner conversation key, which is symmetric — the owner
 *      derives it from their OWN secret key plus the agent's pubkey. The
 *      agent's secret key is never needed.
 *   3. The relay authorizes an engram REQ when the filter's `#p` values all
 *      equal the authenticated reader's pubkey (`engram_filters_authorized`
 *      in `crates/buzz-relay/src/handlers/req.rs`), which is exactly the
 *      filter this module's caller sends.
 *
 * See `docs/nips/NIP-AE.md` for the spec this implements.
 */

/** NIP-AE claims kind 30174 (`KIND_AGENT_ENGRAM` in `buzz-core/src/kind.rs`). */
export const ENGRAM_KIND = 30174;

/** The reserved slug for the agent's core (identity) engram. */
export const CORE_SLUG = "core";

/** Maximum slug length in bytes (spec: *Slugs*). */
export const SLUG_MAX_LEN = 255;

/**
 * Domain prefix for the `d`-tag HMAC, followed by a `0x00` byte and the slug
 * (spec: *Addressing*). Versioned independently of the NIP number.
 */
const D_TAG_DOMAIN = "agent-memory/v1/d-tag";

const MEM_PREFIX = "mem/";

/**
 * One memory entry. Mirrors the desktop's `EngramEntry`
 * (`desktop/src/shared/api/tauriEngrams.ts`) so the ported graph builder and
 * viewer consume an identical shape.
 */
export type EngramEntry = {
  /** Canonical slug — `core`, or `mem/...`. */
  slug: string;
  /** Decrypted UTF-8 payload: `profile` for core, `value` for a memory. */
  body: string;
  eventId: string;
  /** Unix seconds. */
  createdAt: number;
  /** `[[slug]]` references parsed out of `body`. */
  outgoingRefs: string[];
};

/**
 * Single-payload listing for one (agent, owner) pair. Mirrors the desktop's
 * `AgentMemoryListing`, plus the counters the web needs because decryption
 * happens client-side here rather than behind a Tauri command.
 */
export type AgentMemoryListing = {
  /** `core` entry, if the agent has one. */
  core: EngramEntry | null;
  /** All non-core, non-tombstoned memories. Sorted by slug. */
  memories: EngramEntry[];
  /** True when the relay returned its cap — the list may be incomplete. */
  truncated: boolean;
  /** Unix seconds when the listing was assembled. */
  fetchedAt: number;
  /**
   * Frames the viewer's key could not open, or whose envelope/body failed
   * NIP-AE validation. Surfaced in the UI rather than silently dropped: an
   * agent that wrote engrams under a rotated key would otherwise look like
   * an agent with no memory at all.
   */
  undecryptable: number;
};

/** A decoded engram body. The slug discriminates the variant. */
export type EngramBody =
  | { kind: "core"; slug: "core"; profile: string }
  | { kind: "memory"; slug: string; value: string | null };

/**
 * Validate a slug against the *Slugs* grammar:
 * `^mem/[a-z0-9][a-z0-9_-]{0,63}(/[a-z0-9][a-z0-9_-]{0,63})*$`, total length
 * <= 255 bytes, or the reserved string `core`.
 *
 * Byte length, not code-point length: the Rust side measures `slug.len()`
 * on UTF-8 bytes, and a non-ASCII slug is rejected by the segment grammar
 * anyway, so the two agree.
 */
export function validateSlug(slug: string): boolean {
  if (slug === CORE_SLUG) return true;
  if (new TextEncoder().encode(slug).length > SLUG_MAX_LEN) return false;
  if (!slug.startsWith(MEM_PREFIX)) return false;
  const rest = slug.slice(MEM_PREFIX.length);
  if (rest.length === 0) return false;
  return rest.split("/").every(isValidSegment);
}

function isValidSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 64) return false;
  return /^[a-z0-9][a-z0-9_-]*$/.test(segment);
}

/**
 * Extract `[[slug]]` references from a body's free-form text.
 *
 * Ported from `extract_refs` in `buzz-core/src/engram.rs`, including its
 * nesting rule: the first `]]` closes a reference, and an inner `[[`
 * encountered first abandons the outer match and restarts there, so
 * `[[outer [[mem/x]]` still surfaces `mem/x`. Candidates failing
 * {@link validateSlug} are dropped. Results are first-occurrence order,
 * deduplicated.
 */
export function extractRefs(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  // `i + 3 < len` mirrors the Rust bound: `[[x]]` is the shortest form that
  // can hold a non-empty payload.
  while (i + 3 < body.length) {
    if (body[i] === "[" && body[i + 1] === "[") {
      const start = i + 2;
      let j = start;
      let closed = false;
      while (j + 1 < body.length) {
        if (body[j] === "[" && body[j + 1] === "[") break; // inner `[[`
        if (body[j] === "]" && body[j + 1] === "]") {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        const candidate = body.slice(start, j);
        if (validateSlug(candidate) && !out.includes(candidate)) {
          out.push(candidate);
        }
        i = j + 2;
        continue;
      }
      i = start;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Parse a decrypted body per *Bodies* + *Head selection* rule (5).
 *
 * Duplicate object member names at any nesting depth are rejected (rule 3)
 * by {@link parseStrictJson} — `JSON.parse` silently last-wins, which would
 * let two readers disagree on head selection. Unknown fields are ignored.
 * Returns `null` for anything invalid.
 */
export function parseEngramBody(plaintext: string): EngramBody | null {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(plaintext);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const slug = obj.slug;
  if (typeof slug !== "string" || !validateSlug(slug)) return null;

  if (slug === CORE_SLUG) {
    const profile = obj.profile;
    if (typeof profile !== "string") return null;
    return { kind: "core", slug: CORE_SLUG, profile };
  }
  if (!("value" in obj)) return null;
  const value = obj.value;
  if (value === null) return { kind: "memory", slug, value: null };
  if (typeof value !== "string") return null;
  return { kind: "memory", slug, value };
}

/** All values of a single-letter tag on an event, in order. */
function tagValues(event: SignedNostrEvent, name: string): string[] {
  return event.tags
    .filter((tag) => Array.isArray(tag) && tag[0] === name)
    .map((tag) => tag[1] ?? "");
}

/**
 * Derive `d = lower_hex(HMAC-SHA256(K_c, "agent-memory/v1/d-tag" || 0x00 ||
 * slug))` (spec: *Addressing*).
 *
 * Uses WebCrypto rather than pulling in a hashing dependency the web client
 * does not already declare. `crypto.subtle` requires a secure context; the
 * app is served over HTTPS (or localhost), both of which qualify.
 */
export async function deriveDTag(
  conversationKey: Uint8Array,
  slug: string,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto SubtleCrypto is unavailable — agent memory needs a secure context (HTTPS or localhost).",
    );
  }
  const key = await subtle.importKey(
    "raw",
    toArrayBuffer(conversationKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const slugBytes = new TextEncoder().encode(slug);
  const domainBytes = new TextEncoder().encode(D_TAG_DOMAIN);
  const message = new Uint8Array(domainBytes.length + 1 + slugBytes.length);
  message.set(domainBytes, 0);
  message[domainBytes.length] = 0;
  message.set(slugBytes, domainBytes.length + 1);
  const mac = await subtle.sign("HMAC", key, toArrayBuffer(message));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Copy into a plain ArrayBuffer — WebCrypto rejects a SharedArrayBuffer view. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Pick the head from events sharing a `d` tag: greatest `created_at`, ties
 * broken by lowest event id (NIP-01). Port of `select_head`.
 */
export function selectHead<T extends { id: string; created_at: number }>(
  events: readonly T[],
): T | null {
  return events.reduce<T | null>((best, candidate) => {
    if (!best) return candidate;
    if (candidate.created_at > best.created_at) return candidate;
    if (candidate.created_at < best.created_at) return best;
    return candidate.id < best.id ? candidate : best;
  }, null);
}

/**
 * Validate one event against *Head selection* rules (1)–(5) and return its
 * decoded body. Port of `validate_and_decrypt`.
 *
 * `conversationKey` is `K_c` for the agent↔owner pair; the caller derives it
 * once from the owner's secret key and the agent's pubkey.
 *
 * Returns `null` for any failure — bad kind, wrong author, malformed or
 * duplicated `d`/`p` tags, a `p` tag that is not the owner, undecryptable
 * content, an invalid body, or a body whose slug does not re-derive to the
 * event's `d` tag. Callers COUNT the nulls rather than ignoring them.
 */
export async function validateAndDecrypt(
  event: SignedNostrEvent,
  expectedAgentPubkey: string,
  expectedOwnerPubkey: string,
  conversationKey: Uint8Array,
): Promise<EngramBody | null> {
  if (event.kind !== ENGRAM_KIND) return null;
  if (event.pubkey.toLowerCase() !== expectedAgentPubkey.toLowerCase()) {
    return null;
  }

  const dTags = tagValues(event, "d");
  if (dTags.length !== 1) return null;
  const dValue = dTags[0];
  // Spec: `d` is lower-hex. Anything else is non-canonical; refuse it rather
  // than interoperating with a variant encoding.
  if (!/^[0-9a-f]{64}$/.test(dValue)) return null;

  const pTags = tagValues(event, "p");
  if (pTags.length !== 1) return null;
  if (pTags[0].toLowerCase() !== expectedOwnerPubkey.toLowerCase()) return null;

  let plaintext: string;
  try {
    plaintext = nip44.v2.decrypt(event.content, conversationKey);
  } catch {
    return null;
  }

  const body = parseEngramBody(plaintext);
  if (!body) return null;

  // Rule (4): the body's slug must re-derive to the event's `d` tag.
  const derived = await deriveDTag(conversationKey, body.slug);
  if (derived !== dValue) return null;

  return body;
}

/** What {@link decodeEngramListing} needs to turn relay events into a listing. */
export type DecodeEngramParams = {
  events: readonly SignedNostrEvent[];
  agentPubkey: string;
  ownerPubkey: string;
  /** The owner's (viewer's) NIP-44 secret key. */
  ownerSecretKey: Uint8Array;
  /** True when the relay returned its result cap for this query. */
  truncated: boolean;
  /** Unix seconds; injectable so tests are not clock-dependent. */
  nowSeconds?: number;
};

/**
 * Turn a bag of relay events into the panel-ready listing: verify, decrypt,
 * group by `d`, take each group's head, drop tombstones, split `core` out.
 *
 * This is the browser equivalent of the desktop's `get_agent_memory` command
 * body. One deliberate difference: the desktop drops invalid events silently
 * ("a single corrupt event must not deny-of-service the panel"). We keep the
 * drop, but COUNT it — `undecryptable` is surfaced in the UI, because on the
 * web the most likely cause is the viewer holding a different key than the
 * one the agent encrypted to, and "no memories" would be a misleading way to
 * render that.
 */
export async function decodeEngramListing({
  events,
  agentPubkey,
  ownerPubkey,
  ownerSecretKey,
  truncated,
  nowSeconds,
}: DecodeEngramParams): Promise<AgentMemoryListing> {
  const conversationKey = nip44.v2.utils.getConversationKey(
    ownerSecretKey,
    agentPubkey,
  );

  type Decoded = { event: SignedNostrEvent; body: EngramBody };
  const groups = new Map<string, Decoded[]>();
  let undecryptable = 0;

  for (const event of events) {
    // NIP-44 requires the outer signature be checked BEFORE decryption.
    //
    // `verifyEvent` MEMOIZES its answer on the event object under
    // `verifiedSymbol`, and that symbol survives an object spread — so
    // `{...verifiedEvent, sig: forged}` verifies as true. Relay frames arrive
    // straight out of `JSON.parse` and carry no symbol, but clearing it costs
    // nothing and removes a way for the check to be silently skipped.
    if (verifiedSymbol in event) {
      delete (event as { [verifiedSymbol]?: boolean })[verifiedSymbol];
    }
    if (!verifyEvent(event)) {
      undecryptable += 1;
      continue;
    }
    const body = await validateAndDecrypt(
      event,
      agentPubkey,
      ownerPubkey,
      conversationKey,
    );
    if (!body) {
      undecryptable += 1;
      continue;
    }
    const dValue = tagValues(event, "d")[0];
    const group = groups.get(dValue);
    if (group) group.push({ event, body });
    else groups.set(dValue, [{ event, body }]);
  }

  let core: EngramEntry | null = null;
  const memories: EngramEntry[] = [];

  for (const members of groups.values()) {
    const head = selectHead(members.map((m) => m.event));
    if (!head) continue;
    const decoded = members.find((m) => m.event.id === head.id);
    if (!decoded) continue;
    const { body } = decoded;

    if (body.kind === "core") {
      core = {
        slug: CORE_SLUG,
        body: body.profile,
        eventId: head.id,
        createdAt: head.created_at,
        outgoingRefs: extractRefs(body.profile),
      };
      continue;
    }
    // Tombstone (`value: null`) — the slug is absent, not empty.
    if (body.value === null) continue;
    memories.push({
      slug: body.slug,
      body: body.value,
      eventId: head.id,
      createdAt: head.created_at,
      outgoingRefs: extractRefs(body.value),
    });
  }

  memories.sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    core,
    memories,
    truncated,
    fetchedAt: nowSeconds ?? Math.floor(Date.now() / 1000),
    undecryptable,
  };
}
