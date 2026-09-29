import { del, get, set } from "idb-keyval";
import type { NostrFilter } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  isPlainObject,
  parseCardTags,
  type DecisionCard,
} from "./decisionCard.ts";
import {
  applyOverlay,
  DELETE_KIND,
  EDIT_KIND,
  editTargetFromEvent,
  TIMELINE_KINDS,
  timelineMessageFromEvent,
  type MessageBuffer,
  type TimelineMessage,
} from "./messageBuffer.ts";
import { THREAD_SUMMARY_KIND } from "./threadSummaryEvent.ts";
import { reactionFromEvent, type ReactionIndex } from "./reactions.ts";
import {
  SYSTEM_MESSAGE_KIND,
  systemEventFromContent,
  tombstoneTargetId,
} from "./systemEvent.ts";

/**
 * Persistent per-channel timeline cache (IndexedDB via idb-keyval).
 *
 * A reload used to re-fetch a 200-event backlog for every opened timeline.
 * This cache stores the post-overlay timeline state (messages, reactions,
 * sync watermark) so a reload paints instantly from disk and the follow-up
 * REQ asks only for what changed since the watermark (`since` cursor).
 * Deletes remove rows outright — a hidden row must not resurrect from cache.
 */

/**
 * Bump this whenever `TimelineMessage` gains a field the renderer requires.
 *
 * The cache stores whole `TimelineMessage` objects, so an entry written by an
 * older build deserializes with the new field simply ABSENT — and nothing in
 * the read path notices, because a structured-clone read has no schema. That
 * is not theoretical: `linkPreviews` was added to `TimelineMessage` without a
 * bump, and every cached message came back with `linkPreviews === undefined`,
 * so `LinkPreviewCards` threw on `previews.length` and the error boundary
 * replaced the entire app with "Something went wrong" — on first load, for
 * everyone who had ever opened a channel. Measured in a browser against the
 * dev relay on 2026-09-04: 34 of 34 cached messages lacked the field.
 *
 * v2 discards those entries. Renderers should still tolerate a missing field
 * (see `LinkPreviewCards`), because the bump only protects the release that
 * remembers to make it.
 */
const CACHE_VERSION = "v2";
/** Stored message cap — mirrors the in-memory upsertMessage cap. */
export const CACHE_CAP = 500;
/** Upper bound on a catch-up delta; beyond this, scroll-up fills the gap. */
export const DELTA_CAP = 500;
/** First visit (no cursor): fetch only the newest page — scroll-up does the rest. */
export const INITIAL_PAGE = 60;
/** Older-history page size for scroll-up pagination. */
export const OLDER_PAGE = 60;
/**
 * Overlays (kind 5 delete / 40003 edit) issued while this client was away are
 * caught by the delta's `since`, but an overlay recorded just under the
 * watermark of a truncated-by-bug-era cache would never re-arrive. Re-scan a
 * bounded recent overlay window as insurance — it is a tiny filter.
 */
const OVERLAY_BACKFILL_WINDOW_S = 7 * 24 * 60 * 60;
const OVERLAY_BACKFILL_LIMIT = 200;

export interface TimelineCacheEntry {
  /** Post-overlay messages, ascending createdAt, capped at CACHE_CAP. */
  messages: MessageBuffer;
  /** Reaction index (target id → emoji → pubkeys). */
  reactions: ReactionIndex;
  /** Watermark: newest applied message created_at. 0 = nothing synced. */
  cursor: number;
  /** Older pagination already returned a short page — history start reached. */
  historyExhausted: boolean;
  /**
   * Ids this client has seen deleted (kind 5 / 40099 tombstone), newest last,
   * bounded at {@link DELETED_IDS_CAP}. The reducer refuses to (re-)insert a
   * listed id, so a re-delivered original — a warm feed that never saw the
   * delete, a replay — cannot resurrect a row deleted here. Entries cached
   * before the field existed heal to `[]` (healCachedEntry).
   */
  deletedIds: string[];
  /**
   * Edits whose target has not arrived yet (target id → newest content),
   * applied when the target lands. Optional and always read with `?.`, so
   * entries cached before it existed need no heal. Bounded by
   * PENDING_EDITS_CAP.
   */
  pendingEdits?: Record<string, { content: string; at: number }>;
}

/** Bound on {@link TimelineCacheEntry.deletedIds}. */
export const DELETED_IDS_CAP = 200;

/** A fresh, never-synced entry (cursor 0 → the next sync asks for a first page). */
export function emptyTimelineEntry(): TimelineCacheEntry {
  return {
    messages: [],
    reactions: new Map(),
    cursor: 0,
    historyExhausted: false,
    deletedIds: [],
  };
}

export function cacheKey(channelId: string): string {
  return `timeline:${CACHE_VERSION}:${channelId}`;
}

/**
 * Migrate a `card` field cached by a pre-v2-cards build.
 *
 * The cache stores the PARSED card, and cards v2 (2026-09-20) changed the
 * parsed shape: a v1 card used to parse to `{title, body?, options}` and now
 * parses to `{v, title, questions:[…]}`. Every entry cached before that
 * deploy carries the OLD shape, and a renderer reading `card.questions.length`
 * on it blanks the whole app through the error boundary — the same failure
 * class as the `linkPreviews` incident above, one field later and in the
 * opposite direction: not a field the renderer requires that the cache never
 * wrote, but a field whose SHAPE moved under both of them.
 *
 * Rather than a second normalization to keep in step with the parser, the
 * legacy shape is rebuilt into its v1 wire payload and handed to the ONE
 * parser: the healed card is then exactly what `parseCardTags` produces for
 * the same event off the relay. A legacy card too broken to survive that
 * round trip heals to `null`, which renders the message's fallback content —
 * the same degradation as an unparseable tag, never a crash.
 */
function healCachedCard(card: unknown): DecisionCard | null {
  if (card === null || card === undefined) {
    return null;
  }
  if (isPlainObject(card) && Array.isArray(card.questions)) {
    // Already the normalized shape. The reference is returned so an intact
    // entry keeps its identity — see healCachedEntry. The cast goes through
    // `unknown` because the guard is runtime evidence, not a type proof —
    // the cache has no schema, so this is exactly as trusted as the read.
    return card as unknown as DecisionCard;
  }
  if (!isPlainObject(card)) {
    return null;
  }
  const payload: Record<string, unknown> = { v: 1, title: card.title };
  if (card.body !== undefined) {
    payload.body = card.body;
  }
  payload.options = card.options;
  return parseCardTags([["card", JSON.stringify(payload)]]);
}

/**
 * Fill in collection fields a cached message may predate, and migrate a card
 * cached under a shape the renderer has outgrown.
 *
 * A version bump discards stale entries, but only in the release that
 * remembers to make one — and the failure mode when it is forgotten is not a
 * degraded row, it is `undefined.length` inside a renderer, which the error
 * boundary turns into a blank app. So the read path also repairs the shape it
 * gets. Every field here is a collection the timeline iterates over, and an
 * empty one is always the honest answer for a message stored before the field
 * existed: it had none.
 *
 * Scalars are deliberately NOT defaulted. A missing `content` or `createdAt`
 * means the entry is not a message at all, and inventing values would hide
 * that behind a plausible-looking row.
 */
export function healCachedEntry(entry: TimelineCacheEntry): TimelineCacheEntry {
  let repaired = false;
  const messages = entry.messages.map((message) => {
    const needsPreviews = !Array.isArray(message.linkPreviews);
    const needsMentions = !Array.isArray(message.mentionPubkeys);
    const needsImeta = !(message.imetaByUrl instanceof Map);
    // `?? null`: an entry cached before the field existed stores `undefined`,
    // which is null for every purpose here and must NOT count as a repair.
    const sourceCard = message.card ?? null;
    const healedCard = healCachedCard(sourceCard);
    if (
      !needsPreviews &&
      !needsMentions &&
      !needsImeta &&
      healedCard === sourceCard
    ) {
      return message;
    }
    repaired = true;
    return {
      ...message,
      linkPreviews: needsPreviews ? [] : message.linkPreviews,
      mentionPubkeys: needsMentions ? [] : message.mentionPubkeys,
      imetaByUrl: needsImeta ? new Map() : message.imetaByUrl,
      card: healedCard,
    };
  });
  // `deletedIds` (2026-09-27) postdates every entry cached before it: absent
  // heals to `[]`; a non-string member (never written by this build, but the
  // cache has no schema) is dropped rather than trusted.
  const sourceDeleted: unknown = (entry as { deletedIds?: unknown }).deletedIds;
  let deletedIds: string[];
  if (sourceDeleted == null || !Array.isArray(sourceDeleted)) {
    deletedIds = [];
    repaired = true;
  } else if (sourceDeleted.every((id) => typeof id === "string")) {
    deletedIds = sourceDeleted as string[];
  } else {
    deletedIds = sourceDeleted.filter(
      (id): id is string => typeof id === "string",
    );
    repaired = true;
  }
  // Identity is preserved when nothing needed repair, so the common path costs
  // no new object and no re-render downstream.
  return repaired ? { ...entry, messages, deletedIds } : entry;
}

export async function loadTimelineCache(
  channelId: string,
): Promise<TimelineCacheEntry | null> {
  // An evicted (deleted) channel never paints from cache, even if a write
  // raced the eviction — a deleted channel must cold-start, not ghost-open.
  if (evictedChannelIds.has(channelId)) {
    return null;
  }
  try {
    const entry = (await get(cacheKey(channelId))) as
      | TimelineCacheEntry
      | undefined;
    if (!entry || !Array.isArray(entry.messages)) {
      return null;
    }
    return healCachedEntry(entry);
  } catch {
    // Corrupt or unavailable storage: behave like a cold start.
    return null;
  }
}

export async function saveTimelineCache(
  channelId: string,
  entry: TimelineCacheEntry,
): Promise<void> {
  // The open timeline's unmount flush lands here after a delete's eviction —
  // writing it back would resurrect the entry (see evictedChannelIds).
  if (evictedChannelIds.has(channelId)) {
    return;
  }
  try {
    await set(cacheKey(channelId), persistableEntry(entry));
  } catch {
    // Storage full or blocked: caching is an optimization, never fatal.
  }
}

export async function clearTimelineCache(channelId: string): Promise<void> {
  try {
    await del(cacheKey(channelId));
  } catch {
    // Best effort.
  }
}

/**
 * Channel ids whose timeline cache this session has evicted (the delete flow).
 * The point is ordering: deleting a channel that is CURRENTLY OPEN races its
 * own unmount flush, which writes `cacheRef` back to disk — a plain `del`
 * issued before that flush loses, and the deleted channel's full history
 * resurfaces on the next visit (the ghost-open path). Marking the id BEFORE
 * the `del` makes both guards below deterministic: a late writer is skipped,
 * and a late reader cold-starts instead of painting from the evicted entry.
 *
 * Session-scoped by design. If a channel id is recycled (delete `#general`,
 * re-create `#general`) the new channel syncs cold and its cache warms again
 * after a reload; a stale read marker is the worst case, never a wrong one.
 */
const evictedChannelIds = new Set<string>();

/** True once {@link evictTimelineCache} has run for this channel this session. */
export function isTimelineCacheEvicted(channelId: string): boolean {
  return evictedChannelIds.has(channelId);
}

/**
 * Evict one channel's timeline cache — the relay-confirmed delete path.
 * Marks the id first (see the set's doc) so the in-flight unmount flush of an
 * open timeline can never re-persist what we are deleting, then drops the
 * entry from IndexedDB.
 */
export function evictTimelineCache(channelId: string): void {
  evictedChannelIds.add(channelId);
  void clearTimelineCache(channelId);
}

/** Upsert one message into a cache entry, advancing the watermark. Pure. */
export function mergeCachedMessage(
  entry: TimelineCacheEntry,
  message: TimelineMessage,
): TimelineCacheEntry {
  const existing = entry.messages.find((m) => m.id === message.id);
  let messages: MessageBuffer;
  if (existing) {
    if (existing === message) {
      messages = entry.messages;
    } else {
      messages = entry.messages.map((m) => (m.id === message.id ? message : m));
    }
  } else {
    messages = entry.messages
      .concat(message)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (messages.length > CACHE_CAP) {
      messages = messages.slice(messages.length - CACHE_CAP);
    }
  }
  const cursor = Math.max(entry.cursor, message.createdAt);
  return { ...entry, messages, cursor };
}

/** How {@link applyEventToEntry} treats an incoming message. */
export type ApplyMode =
  /**
   * The channel's own sync REQ (open timeline, delta, prefetch, older page):
   * the event is part of a contiguous window, so the watermark advances.
   */
  | "sync"
  /**
   * A message that reached the client through some OTHER feed (unread
   * activity, DM sampler). It says nothing about the span between the cursor
   * and itself, so it may paint but must never move the cursor — the next
   * sync's `since: cursor` still has to fetch that span.
   */
  | "warm";

function recordDeleted(entry: TimelineCacheEntry, id: string): string[] {
  if (entry.deletedIds.includes(id)) {
    return entry.deletedIds;
  }
  const next = entry.deletedIds.concat(id);
  return next.length > DELETED_IDS_CAP
    ? next.slice(next.length - DELETED_IDS_CAP)
    : next;
}

/** Delete overlay in VIEW form: the row stays, flagged, and the id is remembered. */
function deleteInEntry(
  entry: TimelineCacheEntry,
  targetId: string,
): TimelineCacheEntry {
  const deletedIds = recordDeleted(entry, targetId);
  const existing = entry.messages.find((m) => m.id === targetId);
  const messages =
    existing && !existing.deleted
      ? applyOverlay(entry.messages, DELETE_KIND, targetId, null)
      : entry.messages;
  if (messages === entry.messages && deletedIds === entry.deletedIds) {
    return entry;
  }
  return { ...entry, messages, deletedIds };
}

/**
 * One relay event → the next timeline entry. Pure; returns the SAME
 * reference when the event changes nothing, so callers can skip re-renders
 * and disk writes on replayed traffic.
 *
 * This is the one reducer for timeline state: the open timeline's sync sub,
 * scroll-up pages, idle prefetch and the warm taps all go through it
 * (background-sync plan §4.2). Deletes are kept in VIEW form — the row stays
 * with `deleted: true` so the timeline can render its placeholder — and
 * {@link persistableEntry} strips them before anything reaches disk, so a
 * deleted row still never resurrects from cache.
 *
 * Typing (20002) and thread summaries (39005) are session-only view state;
 * they are the caller's to handle and are ignored here.
 */
export function applyEventToEntry(
  entry: TimelineCacheEntry,
  event: SignedNostrEvent,
  channelId: string,
  options: { mode: ApplyMode },
): TimelineCacheEntry {
  if (event.kind === EDIT_KIND || event.kind === DELETE_KIND) {
    const targetId = editTargetFromEvent(event);
    if (!targetId) {
      return entry;
    }
    if (event.kind === DELETE_KIND) {
      return deleteInEntry(entry, targetId);
    }
    const target = entry.messages.find((m) => m.id === targetId);
    if (!target) {
      // A delta REQ returns the edit (newer) before its original when the
      // original sits at the cursor second: hold it until the target lands.
      return holdPendingEdit(entry, targetId, event);
    }
    if (target.edited && target.content === event.content) {
      return entry;
    }
    return {
      ...entry,
      messages: applyOverlay(
        entry.messages,
        EDIT_KIND,
        targetId,
        event.content,
      ),
    };
  }
  if (event.kind === 7) {
    const reaction = reactionFromEvent(event);
    return reaction
      ? mergeCachedReaction(entry, reaction, event.pubkey)
      : entry;
  }
  // 39005 carries an `h` tag, so the message parser would build a row out of
  // it — it must be routed away before the message path.
  if (event.kind === THREAD_SUMMARY_KIND || event.kind === 20002) {
    return entry;
  }
  const message = timelineMessageFromEvent(event);
  if (!message || message.channelId !== channelId) {
    return entry;
  }
  if (entry.deletedIds.includes(message.id)) {
    return entry;
  }
  let next = entry;
  // A 40099 tombstone reports a removal the relay already made: hide the
  // target through the same delete path kind 5 uses.
  if (message.kind === SYSTEM_MESSAGE_KIND) {
    const removedId = tombstoneTargetId(
      systemEventFromContent(message.content),
    );
    if (removedId) {
      next = deleteInEntry(next, removedId);
    }
  }
  const existing = next.messages.find((m) => m.id === message.id);
  if (existing && (existing.edited || existing.deleted)) {
    // A re-delivered ORIGINAL must not undo an overlay already applied.
    return next;
  }
  // Rule 2 (warm): only rows at-or-after the watermark. An older event
  // (search, thread, forum read) cannot be known contiguous; inserting it
  // would make loadOlder — keyed on the oldest row — skip real history.
  // The sync path also owns rows it already has; a warm copy adds nothing.
  if (
    options.mode === "warm" &&
    (message.createdAt < next.cursor || existing)
  ) {
    return next;
  }
  const pending = next.pendingEdits?.[message.id];
  let incoming = message;
  if (pending) {
    incoming = { ...message, content: pending.content, edited: true };
    const rest = { ...next.pendingEdits };
    delete rest[message.id];
    next = { ...next, pendingEdits: rest };
  }
  if (options.mode === "warm") {
    let messages = next.messages
      .concat(incoming)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (messages.length > CACHE_CAP) {
      messages = messages.slice(messages.length - CACHE_CAP);
    }
    // Rule 1: the cursor is deliberately untouched.
    return { ...next, messages };
  }
  return mergeCachedMessage(next, incoming);
}

/** Pending (target-not-yet-seen) edits kept per entry. */
export const PENDING_EDITS_CAP = 100;

function holdPendingEdit(
  entry: TimelineCacheEntry,
  targetId: string,
  event: SignedNostrEvent,
): TimelineCacheEntry {
  const held = entry.pendingEdits?.[targetId];
  // Newest edit wins; a replayed or older edit changes nothing.
  if (held && held.at >= event.created_at) {
    return entry;
  }
  const pendingEdits = {
    ...entry.pendingEdits,
    [targetId]: { content: event.content, at: event.created_at },
  };
  const ids = Object.keys(pendingEdits);
  if (ids.length > PENDING_EDITS_CAP) {
    ids
      .sort((a, b) => pendingEdits[a].at - pendingEdits[b].at)
      .slice(0, ids.length - PENDING_EDITS_CAP)
      .forEach((id) => delete pendingEdits[id]);
  }
  return { ...entry, pendingEdits };
}

/**
 * The on-disk form of an entry: rows deleted in this session are dropped
 * outright (view-form `deleted: true` rows must not resurrect from disk).
 */
export function persistableEntry(
  entry: TimelineCacheEntry,
): TimelineCacheEntry {
  if (!entry.messages.some((m) => m.deleted)) {
    return entry;
  }
  return { ...entry, messages: entry.messages.filter((m) => !m.deleted) };
}

/**
 * Apply an edit/delete overlay to a cache entry. Pure. Edits patch the target
 * and mark it edited; deletes REMOVE the row (hidden rows must not resurrect
 * from disk on the next reload).
 */
export function applyOverlayToCache(
  entry: TimelineCacheEntry,
  kind: number,
  targetId: string,
  newContent: string | null,
): TimelineCacheEntry {
  if (kind === EDIT_KIND && newContent === null) {
    return entry;
  }
  const index = entry.messages.findIndex((m) => m.id === targetId);
  if (index === -1) {
    return entry;
  }
  let messages: MessageBuffer;
  if (kind === EDIT_KIND) {
    messages = entry.messages.map((m) =>
      m.id === targetId
        ? { ...m, content: newContent ?? m.content, edited: true }
        : m,
    );
  } else if (kind === DELETE_KIND) {
    messages = entry.messages.filter((m) => m.id !== targetId);
  } else {
    return entry;
  }
  return { ...entry, messages };
}

/** Merge a reaction into a cache entry. Pure. */
export function mergeCachedReaction(
  entry: TimelineCacheEntry,
  reaction: { targetId: string; emoji: string },
  authorPubkey: string,
): TimelineCacheEntry {
  const byEmoji = entry.reactions.get(reaction.targetId) ?? new Map();
  const pubkeys = byEmoji.get(reaction.emoji) ?? [];
  if (pubkeys.includes(authorPubkey)) {
    return entry;
  }
  const nextByEmoji = new Map(byEmoji);
  nextByEmoji.set(reaction.emoji, [...pubkeys, authorPubkey]);
  const next = new Map(entry.reactions);
  next.set(reaction.targetId, nextByEmoji);
  return { ...entry, reactions: next };
}

/**
 * Drop one author's reaction from the cached index.
 *
 * The counterpart to {@link mergeCachedReaction}, which only ever adds. Without
 * this a removed reaction reappears on reload: the chip is gone from live state
 * but IndexedDB still holds it, so the cached paint restores it until a delta
 * happens to overwrite that entry — which, for a reaction nobody touches again,
 * is never.
 */
export function dropCachedReaction(
  entry: TimelineCacheEntry,
  reaction: { targetId: string; emoji: string },
  authorPubkey: string,
): TimelineCacheEntry {
  const byEmoji = entry.reactions.get(reaction.targetId);
  const pubkeys = byEmoji?.get(reaction.emoji);
  if (!byEmoji || !pubkeys?.includes(authorPubkey)) {
    return entry;
  }
  const remaining = pubkeys.filter((pubkey) => pubkey !== authorPubkey);
  const nextByEmoji = new Map(byEmoji);
  if (remaining.length === 0) {
    nextByEmoji.delete(reaction.emoji);
  } else {
    nextByEmoji.set(reaction.emoji, remaining);
  }
  const next = new Map(entry.reactions);
  if (nextByEmoji.size === 0) {
    next.delete(reaction.targetId);
  } else {
    next.set(reaction.targetId, nextByEmoji);
  }
  return { ...entry, reactions: next };
}

/**
 * Live kinds for a channel subscription.
 *
 * 39005 is the relay's thread-summary overlay. It is never stored, so it
 * contributes nothing to a historical replay — it is here purely so the live
 * push arrives on the SAME REQ as the messages. Giving it a filter of its
 * own would be worse than useless: a filter without `#h` makes the relay
 * register the whole subscription as global and stop delivering
 * channel-scoped events to any of its filters
 * (`extract_channel_ids_from_filters` in `handlers/req.rs`).
 */
const LIVE_KINDS = [
  ...TIMELINE_KINDS,
  7,
  20002,
  EDIT_KIND,
  DELETE_KIND,
  THREAD_SUMMARY_KIND,
] as const;

/** Initial sync filters: full first page on a cold start, delta afterwards. */
export function initialSyncFilters(
  channelId: string,
  cursor: number | null,
): NostrFilter[] {
  if (cursor === null || cursor <= 0) {
    return [
      {
        kinds: [...LIVE_KINDS],
        "#h": [channelId],
        limit: INITIAL_PAGE,
      },
    ];
  }
  return [
    {
      kinds: [...LIVE_KINDS],
      "#h": [channelId],
      since: cursor,
      limit: DELTA_CAP,
    },
    {
      kinds: [EDIT_KIND, DELETE_KIND],
      "#h": [channelId],
      since: Math.max(0, cursor - OVERLAY_BACKFILL_WINDOW_S),
      limit: OVERLAY_BACKFILL_LIMIT,
    },
  ];
}

/**
 * One older-history page for scroll-up pagination. Overlays and reactions
 * ride along with the same `until` window, so an edit or delete issued in
 * that era applies as the page lands. (A reaction posted long after its
 * target stays outside the target's page window — the same bound the old
 * fixed-window fetch had; reactions for cached rows arrive live regardless.)
 */
export function olderPageFilter(
  channelId: string,
  oldestLoadedCreatedAt: number,
): NostrFilter {
  // `until` is inclusive and deliberately AT the oldest loaded row's second:
  // other messages from that same second are not loaded yet, and stepping
  // below it skipped them for good. The overlap is deduped by id; see
  // {@link olderPageExhausted} for when to stop.
  return {
    kinds: [...TIMELINE_KINDS, 7, EDIT_KIND, DELETE_KIND],
    "#h": [channelId],
    until: Math.max(0, oldestLoadedCreatedAt),
    limit: OLDER_PAGE,
  };
}

/**
 * Whether an older page shows the channel's start was reached. A short page
 * (fewer events than the limit) means the relay had nothing more at or below
 * `until`; a full page that brought no NEW message means only the already
 * loaded overlap came back. Page size alone is not enough since `until` is
 * inclusive.
 */
export function olderPageExhausted(page: {
  events: number;
  newMessages: number;
}): boolean {
  return page.events < OLDER_PAGE || page.newMessages === 0;
}
