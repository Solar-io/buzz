import { del, get, set } from "idb-keyval";
import {
  parseCardTags,
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
 * the bump that was forgotten).
 */

const CACHE_VERSION = "v1";

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
    // Re-tagged as a v=1 card payload: the parse demands the version field,
    // so storing the bare parsed shape would fail its own replay.
    cardJson: JSON.stringify({ v: 1, ...ask.card }),
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

/**
 * Fold one discovery result into the entry. Pure. Dedupes by id, keeps
 * newest-first order, caps at ASKS_CACHE_CAP, advances the cursor, prunes
 * `answered` when the cap evicted a card.
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
  return pruneAnswered({ ...entry, asks: merged, cursor });
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
