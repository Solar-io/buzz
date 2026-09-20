import { del, get, set } from "idb-keyval";
import {
  parseCardTags,
  serializeCardPayload,
  type DecisionCard,
} from "@/features/channels/lib/decisionCard.ts";
import type { AskItem } from "./askDetection.ts";

/**
 * Persistent asks state (IndexedDB via idb-keyval), patterned on
 * `timelineCache.ts`. A reload paints the badge instantly from this cache;
 * the discovery/answer REQs then reconcile against the relay. The cache is
 * an optimization, never a source of truth: corrupt or unavailable storage
 * cold-starts (same catch discipline as `loadTimelineCache`).
 *
 * localStorage is deliberately NOT used for the badge — the ask set and the
 * `answered` map rewrite on every answer, which is beyond a sane localStorage
 * churn budget, and idb is already a web dependency.
 *
 * ## Shape discipline
 *
 * The stored ask is the RAW card tag JSON (`cardJson`), not the parsed card:
 * re-parsing on load means a payload written by an older build is validated
 * by the CURRENT parser, and an entry that fails validation degrades to
 * "not an ask" instead of shipping a shape the renderer cannot draw. Bump
 * `CACHE_VERSION` on a shape change (timelineCache's doc tells the story of
 * the bump that was forgotten) — "v2" is the decision-card v2 wire format,
 * whose stored payload is written by `serializeCardPayload` rather than by
 * re-tagging the parsed card.
 */

const CACHE_VERSION = "v2";

/** Stored ask cap — the badge tracks at most this many asks. */
export const ASKS_CACHE_CAP = 100;

/** One persisted ask: the detection inputs, replayable without the feed. */
export interface CachedAsk {
  id: string;
  channelId: string;
  /** Channel type — re-derived on load, kept for the label until then. */
  channelType: AskItem["channelType"];
  authorPubkey: string;
  createdAt: number;
  cardJson: string;
  /**
   * The card's NIP-10 placement, so an answer fired from a cache-painted row
   * still carries the correct thread root (relay ancestry check).
   */
  cardRootId: string | null;
  cardReplyToId: string | null;
}

export interface AsksCacheEntry {
  /** Newest-first, capped at ASKS_CACHE_CAP. */
  asks: CachedAsk[];
  /** cardId → my answer event id. Grows monotonically, pruned with the cap. */
  answered: Record<string, string>;
  /** Newest discovery-feed created_at seen. Discovery watermark. */
  cursor: number;
}

export function asksCacheKey(): string {
  return `asks:${CACHE_VERSION}`;
}

export async function loadAsksCache(): Promise<AsksCacheEntry | null> {
  try {
    const entry = (await get(asksCacheKey())) as AsksCacheEntry | undefined;
    if (
      !entry ||
      !Array.isArray(entry.asks) ||
      typeof entry.answered !== "object" ||
      entry.answered === null
    ) {
      return null;
    }
    return entry;
  } catch {
    // Corrupt or unavailable storage (node test env, private mode, quota):
    // behave like a cold start.
    return null;
  }
}

export async function saveAsksCache(entry: AsksCacheEntry): Promise<void> {
  try {
    await set(asksCacheKey(), entry);
  } catch {
    // Storage full or blocked: caching is an optimization, never fatal.
  }
}

export async function clearAsksCache(): Promise<void> {
  try {
    await del(asksCacheKey());
  } catch {
    // Best effort.
  }
}

/** Project a live ask down to its stored form. */
export function toCachedAsk(ask: AskItem): CachedAsk {
  return {
    id: ask.id,
    channelId: ask.channelId,
    channelType: ask.channelType,
    authorPubkey: ask.authorPubkey,
    createdAt: ask.createdAt,
    // Re-serialized through the decisionCard module: the parse demands the
    // version field AND the wire shape, which stopped being "the parsed card
    // plus a version" when v2 landed. `serializeCardPayload` is the inverse
    // of `parseCardTags`, pinned by a round-trip test.
    cardJson: serializeCardPayload(ask.card),
    cardRootId: ask.rootId,
    cardReplyToId: ask.replyToId,
  };
}

/** Re-parse a stored ask through the CURRENT parser; null when it fails. */
export function fromCachedAsk(cached: CachedAsk): AskItem | null {
  let card: DecisionCard | null = null;
  try {
    card = parseCardTags([["card", cached.cardJson]]);
  } catch {
    card = null;
  }
  if (!card) {
    return null;
  }
  return {
    id: cached.id,
    channelId: cached.channelId,
    channelType: cached.channelType,
    authorPubkey: cached.authorPubkey,
    createdAt: cached.createdAt,
    card,
    // Entries written before these fields existed (a v1 cache from an
    // intermediate build) degrade to a top-level card, the common shape.
    rootId: cached.cardRootId ?? null,
    replyToId: cached.cardReplyToId ?? null,
  };
}

/**
 * Drop `answered` keys whose card is no longer tracked. The map grows on
 * every answer; without this it never shrinks, and a card id evicted by the
 * cap would pin its answer entry forever. Cards that RETURN (relay re-delivery)
 * simply re-accumulate — an entry re-added after pruning is a fresh, correct one.
 */
function pruneAnswered(entry: AsksCacheEntry): AsksCacheEntry {
  const tracked = new Set(entry.asks.map((ask) => ask.id));
  let changed = false;
  const answered: Record<string, string> = {};
  for (const [cardId, answerId] of Object.entries(entry.answered)) {
    if (tracked.has(cardId)) {
      answered[cardId] = answerId;
    } else {
      changed = true;
    }
  }
  return changed ? { ...entry, answered } : entry;
}

/** Content equality for two entries — identity would lie, merges rebuild. */
export function sameEntry(a: AsksCacheEntry, b: AsksCacheEntry): boolean {
  if (a.cursor !== b.cursor || a.asks.length !== b.asks.length) {
    return false;
  }
  const aAnswers = Object.entries(a.answered);
  const bAnswers = Object.entries(b.answered);
  if (aAnswers.length !== bAnswers.length) {
    return false;
  }
  for (const [cardId, answerId] of aAnswers) {
    if (b.answered[cardId] !== answerId) {
      return false;
    }
  }
  for (let i = 0; i < a.asks.length; i += 1) {
    const x = a.asks[i];
    const y = b.asks[i];
    if (
      x.id !== y.id ||
      x.channelId !== y.channelId ||
      x.channelType !== y.channelType ||
      x.authorPubkey !== y.authorPubkey ||
      x.createdAt !== y.createdAt ||
      x.cardJson !== y.cardJson ||
      x.cardRootId !== y.cardRootId ||
      x.cardReplyToId !== y.cardReplyToId
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Fold one discovery result into the entry. Pure. Dedupes by id, keeps
 * newest-first order, caps at ASKS_CACHE_CAP, advances the cursor, prunes
 * `answered` when the cap evicted a card.
 *
 * Returns the SAME entry when nothing content-changed. This is load-bearing,
 * not tidiness: the provider's persist effect re-merges on every render whose
 * deps moved — a merge that kept returning a fresh object would feed its own
 * state update back into the effect and loop forever.
 */
export function mergeCachedAsks(
  entry: AsksCacheEntry,
  asks: readonly AskItem[],
): AsksCacheEntry {
  if (asks.length === 0) {
    return entry;
  }
  const byId = new Map(entry.asks.map((ask) => [ask.id, ask]));
  for (const ask of asks) {
    byId.set(ask.id, toCachedAsk(ask));
  }
  const merged = Array.from(byId.values())
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, ASKS_CACHE_CAP);
  const cursor = asks.reduce(
    (max, ask) => Math.max(max, ask.createdAt),
    entry.cursor,
  );
  const candidate = pruneAnswered({ ...entry, asks: merged, cursor });
  return sameEntry(entry, candidate) ? entry : candidate;
}

/** Record my answer to one card. Pure; idempotent per (cardId, answerId). */
export function markCachedAnswered(
  entry: AsksCacheEntry,
  cardId: string,
  answerId: string,
): AsksCacheEntry {
  if (entry.answered[cardId] === answerId) {
    return entry;
  }
  return {
    ...entry,
    answered: { ...entry.answered, [cardId]: answerId },
  };
}

/** What the provider's persist step should do with one merge candidate. */
export interface PersistDecision {
  /** The entry to hold in provider state (may equal `current` by content). */
  entry: AsksCacheEntry;
  /** True when disk content differs — the entry must be written. */
  persist: boolean;
  /** True when provider state differs — the entry must replace it. */
  stateChanges: boolean;
}

/**
 * Merge discovered asks into the provider's current entry and decide, by
 * CONTENT against the last written entry, whether the result goes to disk.
 *
 * The comparison basis is load-bearing. The natural-looking gate — compare
 * `asks`/`answered` object identity inside the merged candidate — cannot see
 * an answered-only fold: the candidate is built by spreading the CURRENT
 * state, so its `answered` map is the folded one by construction and the
 * comparison reads the map against itself. Every answer that did not happen
 * to co-fire with a discovery change was then silently dropped from disk,
 * and the badge resurrected on reload (the e2e defect: a card answered from
 * the web client came back as unread one reload later).
 */
export function nextPersistedEntry(
  current: AsksCacheEntry | null,
  saved: AsksCacheEntry | null,
  asks: readonly AskItem[],
): PersistDecision | null {
  if (!current) {
    return null;
  }
  const merged = mergeCachedAsks(current, asks);
  return {
    entry: merged,
    persist: saved === null || !sameEntry(saved, merged),
    stateChanges: !sameEntry(current, merged),
  };
}
