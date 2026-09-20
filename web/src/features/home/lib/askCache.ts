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

/**
 * Keys this build has superseded. A version bump orphans the old entry —
 * nothing reads `asks:v1` any more, so it is never MIS-read, but idb keeps it
 * forever: a few hundred KB of dead asks per browser profile. Deleted on
 * first load, which is the only moment the cache is already being touched.
 * Add the outgoing key here whenever `CACHE_VERSION` moves.
 */
const SUPERSEDED_CACHE_KEYS = ["asks:v1"];

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

/**
 * How far through one interview my newest answer got. The inbox's `N/M`
 * chip (a later phase) reads this; the badge never does — a card with
 * progress and no `answered` entry is still an open ask, which is the whole
 * point of a partial.
 *
 * `at` is the answering event's `created_at`, kept so NEWEST wins
 * deterministically. Answer events arrive over several REQ families (history,
 * live, targeted, a 5-minute heartbeat) in no particular order, so without it
 * a replayed older partial would overwrite a newer one.
 */
export interface AskProgress {
  answered: number;
  total: number;
  at: number;
}

export interface AsksCacheEntry {
  /** Newest-first, capped at ASKS_CACHE_CAP. */
  asks: CachedAsk[];
  /**
   * cardId → my answer event id. **Only `done:true` answers land here** —
   * this map is what clears the badge, so a partial must never reach it.
   * Grows monotonically, pruned with the cap.
   */
  answered: Record<string, string>;
  /**
   * cardId → newest partial progress. Absent in entries written before
   * this field existed; `loadAsksCache` normalizes those to `{}`.
   */
  progress: Record<string, AskProgress>;
  /** Newest discovery-feed created_at seen. Discovery watermark. */
  cursor: number;
}

/** A cold-start entry — one shape, so no caller invents a partial one. */
export function emptyAsksCacheEntry(): AsksCacheEntry {
  return { asks: [], answered: {}, progress: {}, cursor: 0 };
}

export function asksCacheKey(): string {
  return `asks:${CACHE_VERSION}`;
}

/** Best-effort eviction of the keys a version bump left behind. */
export async function dropSupersededAsksCaches(): Promise<void> {
  for (const key of SUPERSEDED_CACHE_KEYS) {
    if (key === asksCacheKey()) {
      continue;
    }
    try {
      await del(key);
    } catch {
      // Storage unavailable: the orphan is inert, so this never matters
      // enough to fail a load over.
    }
  }
}

export async function loadAsksCache(): Promise<AsksCacheEntry | null> {
  await dropSupersededAsksCaches();
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
    // `progress` arrived after `asks`/`answered`: an entry written by an
    // earlier build of this same CACHE_VERSION is valid and simply has none.
    // Normalizing beats bumping the version — a bump would throw away a
    // perfectly good badge state to add an empty map.
    return typeof entry.progress === "object" && entry.progress !== null
      ? entry
      : { ...entry, progress: {} };
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
    //
    // Which asks the old `JSON.stringify({v: 1, ...card})` actually broke,
    // measured rather than assumed (QA, 9/20): the spread WINS, so `card.v`
    // overwrote the leading `1` and a v2 card round-tripped fine. The
    // casualty was v1 — and v1 is every ask shipped since 9/16. A v1
    // DecisionCard serialized to `{"v":1,…,"questions":[…]}` with no
    // `options`, which is exactly what the parser's v1 arm refuses, so the
    // ask was dropped on read and the badge lost it.
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
  // `progress` is pruned by the SAME rule and for the same reason: a card
  // evicted by the cap would otherwise pin its partial forever.
  const progress: Record<string, AskProgress> = {};
  for (const [cardId, entryProgress] of Object.entries(entry.progress ?? {})) {
    if (tracked.has(cardId)) {
      progress[cardId] = entryProgress;
    } else {
      changed = true;
    }
  }
  return changed ? { ...entry, answered, progress } : entry;
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
  // Progress is compared here for the same reason `answered` is, and it is
  // the same trap: the persist step decides whether to WRITE by asking this
  // function, so a field it does not look at is a field that silently never
  // reaches disk (the 2026-09-17 badge-resurrect defect, one field over).
  const aProgress = Object.entries(a.progress ?? {});
  const bProgress = Object.entries(b.progress ?? {});
  if (aProgress.length !== bProgress.length) {
    return false;
  }
  for (const [cardId, progress] of aProgress) {
    const other = b.progress?.[cardId];
    if (
      !other ||
      other.answered !== progress.answered ||
      other.total !== progress.total ||
      other.at !== progress.at
    ) {
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

/**
 * Record how far a PARTIAL answer got. Pure; newest (`at`) wins, ties keep
 * what is already stored so a replayed event is a no-op.
 *
 * Returns the SAME entry when nothing moved — load-bearing for the same
 * reason `mergeCachedAsks` is: the provider's persist effect re-runs on every
 * dep change, and a fresh object every time feeds its own state update back
 * into the effect forever.
 */
export function recordCachedProgress(
  entry: AsksCacheEntry,
  cardId: string,
  progress: AskProgress,
): AsksCacheEntry {
  const current = entry.progress?.[cardId];
  if (current && current.at >= progress.at) {
    return entry;
  }
  if (
    current &&
    current.answered === progress.answered &&
    current.total === progress.total
  ) {
    return entry;
  }
  return {
    ...entry,
    progress: { ...(entry.progress ?? {}), [cardId]: progress },
  };
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
