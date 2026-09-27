import { del, get, set } from "idb-keyval";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { MessageBuffer, TimelineMessage } from "./messageBuffer.ts";
import type { ReactionIndex } from "./reactions.ts";
import {
  applyEventToEntry,
  cacheKey,
  CACHE_CAP,
  emptyTimelineEntry,
  INITIAL_PAGE,
  isTimelineCacheEvicted,
  loadTimelineCache,
  saveTimelineCache,
  type TimelineCacheEntry,
} from "./timelineCache.ts";

/**
 * Shared per-channel timeline store (background-sync plan §4.2).
 *
 * The ONE owner of timeline cache state in the web client: an in-memory LRU
 * over the IndexedDB cache, fed by the open timeline's sync subscription
 * AND by "warm" writes — kind-9 events the client already receives through
 * other feeds (the unread activity feed, the DM sampler, DM unread counts).
 * A channel switch therefore paints synchronously from memory
 * ({@link TimelineStore.peek}) instead of starting with an async IDB read,
 * and a message that already reached the client paints with no network in
 * the critical path.
 *
 * Warm-write rules (each has a test in timelineStore.test.mjs /
 * timelineCache.test.mjs):
 *  1. A warm write never advances the cursor (the reducer's "warm" mode).
 *  2. It is accepted only at-or-after the cursor (same).
 *  3. It never touches the OWNED channel — the open timeline's sync sub is
 *     the sole writer there (see {@link TimelineStore.setOwner}).
 *  4. A deleted id never re-enters (the reducer's `deletedIds`).
 * Entries the user has not opened this session are capped at
 * {@link WARM_ROW_CAP} rows.
 */

/** Source of an event handed to {@link TimelineStore.apply}. */
export type TimelineEventSource =
  /** The open timeline's own sync sub or its scroll-up pages. */
  | "timeline"
  /** An idle-prefetch delta REQ (contiguous since the cursor). */
  | "prefetch"
  /** Warm taps: events that arrived through another feed. */
  | "activity"
  | "dms"
  | "unread";

function isWarmSource(source: TimelineEventSource): boolean {
  return source !== "timeline" && source !== "prefetch";
}

/** In-memory entries kept on browsers. */
export const STORE_CAPACITY = 8;
/** In-memory entries kept inside the native iOS shell (tighter memory). */
export const STORE_CAPACITY_IOS = 4;
/** Row cap for an entry the user has not opened this session. */
export const WARM_ROW_CAP = INITIAL_PAGE;
/** IndexedDB timeline entries kept (LRU by last write). */
export const DISK_CAPACITY = 40;
/** Write-behind debounce per channel. */
export const FLUSH_DEBOUNCE_MS = 1_000;
/** Last-touched index of every persisted timeline entry. */
export const INDEX_KEY = "timeline:v2:index";

export interface TimelineStoreOptions {
  capacity?: number;
  warmRowCap?: number;
  diskCapacity?: number;
  flushMs?: number;
  now?: () => number;
}

type Listener = (entry: TimelineCacheEntry) => void;

export interface TimelineStore {
  /** Synchronous memory read. null on a miss or for an evicted channel. */
  peek(channelId: string): TimelineCacheEntry | null;
  /** Memory, else IndexedDB (healed), else a fresh empty entry. */
  load(channelId: string): Promise<TimelineCacheEntry>;
  /** Run one relay event through the reducer (see TimelineEventSource). */
  apply(
    channelId: string,
    event: SignedNostrEvent,
    options: { source: TimelineEventSource },
  ): void;
  /** Functional update of a loaded entry (pagination flags, own-reaction drop). */
  update(
    channelId: string,
    fn: (entry: TimelineCacheEntry) => TimelineCacheEntry,
  ): void;
  /** Mark a channel as the open timeline (ref-counted). */
  setOwner(channelId: string): void;
  /** Release an owner claim and persist the entry now. */
  releaseOwner(channelId: string): void;
  isOwned(channelId: string): boolean;
  subscribe(channelId: string, listener: Listener): () => void;
  /** Write every dirty entry now (tests / page hide). */
  flushAll(): Promise<void>;
  /** Ids currently in memory, least-recently-used first (diagnostics/tests). */
  memoryIds(): string[];
}

/** One disk-index row: last write time and whether it was ever opened. */
interface IndexRecord {
  at: number;
  opened: boolean;
}

function healIndexRecord(value: unknown): IndexRecord | null {
  if (typeof value === "number") {
    // Written before the opened flag existed: treat as opened (safe side).
    return { at: value, opened: true };
  }
  if (value && typeof value === "object") {
    const record = value as Partial<IndexRecord>;
    if (typeof record.at === "number") {
      return { at: record.at, opened: record.opened === true };
    }
  }
  return null;
}

/**
 * Merge a (trimmed) view back into the untrimmed entry it came from: every
 * row of both, the view winning per id (it carries the newer overlays),
 * rows deleted in the view flagged deleted, and the base's
 * historyExhausted kept.
 */
export function mergeFull(
  base: TimelineCacheEntry,
  view: TimelineCacheEntry,
): TimelineCacheEntry {
  const byId = new Map<string, TimelineMessage>();
  for (const message of base.messages) {
    byId.set(message.id, message);
  }
  for (const message of view.messages) {
    byId.set(message.id, message);
  }
  for (const id of view.deletedIds) {
    const row = byId.get(id);
    if (row && !row.deleted) {
      byId.set(id, { ...row, deleted: true });
    }
  }
  let messages = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  if (messages.length > CACHE_CAP) {
    messages = messages.slice(messages.length - CACHE_CAP);
  }
  return {
    ...view,
    messages,
    cursor: Math.max(base.cursor, view.cursor),
    historyExhausted: base.historyExhausted,
  };
}

/**
 * The cursor the open-time sync REQ should ask from. A synced entry uses its
 * watermark. A never-synced entry (cursor 0) that holds warm rows asks from
 * its OLDEST warm row: a cold "newest page" could come back shorter than
 * the warm rows reach, and `loadOlder` (keyed on the oldest row) would then
 * skip the span between the page and the warm rows.
 */
export function syncCursor(entry: TimelineCacheEntry | null): number | null {
  if (!entry) {
    return null;
  }
  if (entry.cursor > 0) {
    return entry.cursor;
  }
  return entry.messages[0]?.createdAt ?? null;
}

export function createTimelineStore(
  options: TimelineStoreOptions = {},
): TimelineStore {
  const capacity = options.capacity ?? STORE_CAPACITY;
  const warmRowCap = options.warmRowCap ?? WARM_ROW_CAP;
  const diskCapacity = options.diskCapacity ?? DISK_CAPACITY;
  const flushMs = options.flushMs ?? FLUSH_DEBOUNCE_MS;
  const now = options.now ?? (() => Date.now());

  /** Insertion order is recency: touch = delete + set. */
  const entries = new Map<string, TimelineCacheEntry>();
  /** Channels opened (owned at least once) this session: no warm row cap. */
  const opened = new Set<string>();
  const owners = new Map<string, number>();
  const listeners = new Map<string, Set<Listener>>();
  const loads = new Map<string, Promise<TimelineCacheEntry>>();
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Latest entry awaiting its disk write, per channel (coalesces). */
  const pendingWrites = new Map<string, TimelineCacheEntry>();
  /** Per-channel write chain: at most one `set` in flight per key. */
  const writeChains = new Map<string, Promise<void>>();
  /**
   * The UNTRIMMED entry behind a warm-only view that was capped: the rows
   * dropped from memory still belong on disk. Persistence and opening merge
   * the view back into it, so a 60-row warm view never overwrites a larger
   * saved history (or its historyExhausted flag).
   */
  const full = new Map<string, TimelineCacheEntry>();
  let index: Record<string, IndexRecord> | null = null;
  let indexChain: Promise<void> = Promise.resolve();

  const touch = (channelId: string, entry: TimelineCacheEntry) => {
    entries.delete(channelId);
    entries.set(channelId, entry);
    evictOverflow();
  };

  const notify = (channelId: string, entry: TimelineCacheEntry) => {
    for (const listener of listeners.get(channelId) ?? []) {
      listener(entry);
    }
  };

  function evictOverflow(): void {
    if (entries.size <= capacity) {
      return;
    }
    for (const id of entries.keys()) {
      if (entries.size <= capacity) {
        break;
      }
      // The open timeline is never evicted from under its view.
      if ((owners.get(id) ?? 0) > 0) {
        continue;
      }
      if (flushTimers.has(id)) {
        flushNow(id);
      }
      entries.delete(id);
      full.delete(id);
    }
  }

  async function readIndex(): Promise<Record<string, IndexRecord>> {
    if (index) {
      return index;
    }
    const healed: Record<string, IndexRecord> = {};
    try {
      const stored = (await get(INDEX_KEY)) as unknown;
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [id, value] of Object.entries(stored)) {
          const record = healIndexRecord(value);
          if (record) {
            healed[id] = record;
          }
        }
      }
    } catch {
      // Unreadable index: start fresh; eviction resumes from here.
    }
    index = healed;
    return healed;
  }

  /** Record a write and drop the least-recently-written entries beyond the cap. */
  function recordWrite(channelId: string): Promise<void> {
    indexChain = indexChain.then(async () => {
      const current = await readIndex();
      current[channelId] = {
        at: now(),
        opened: current[channelId]?.opened === true || opened.has(channelId),
      };
      const ids = Object.keys(current);
      if (ids.length > diskCapacity) {
        // Warm-only entries go first (oldest first), then opened ones: a
        // channel the user actually read outranks one only ever warmed.
        const oldestFirst = ids.sort(
          (a, b) =>
            Number(current[a].opened) - Number(current[b].opened) ||
            current[a].at - current[b].at,
        );
        for (const id of oldestFirst.slice(0, ids.length - diskCapacity)) {
          delete current[id];
          try {
            await del(cacheKey(id));
          } catch {
            // Best effort: an orphan costs disk, never correctness.
          }
        }
      }
      try {
        await set(INDEX_KEY, current);
      } catch {
        // Storage full or blocked: the next write retries.
      }
    });
    return indexChain;
  }

  function flushNow(channelId: string): Promise<void> {
    const timer = flushTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      flushTimers.delete(channelId);
    }
    const entry = entries.get(channelId);
    if (entry) {
      const base = full.get(channelId);
      pendingWrites.set(channelId, base ? mergeFull(base, entry) : entry);
    }
    const previous = writeChains.get(channelId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const toWrite = pendingWrites.get(channelId);
      if (!toWrite) {
        return; // Coalesced into an earlier write in this chain.
      }
      pendingWrites.delete(channelId);
      if (isTimelineCacheEvicted(channelId)) {
        return;
      }
      await saveTimelineCache(channelId, toWrite);
      await recordWrite(channelId);
    });
    writeChains.set(channelId, next);
    void next.finally(() => {
      if (writeChains.get(channelId) === next) {
        writeChains.delete(channelId);
      }
    });
    return next;
  }

  function scheduleFlush(channelId: string): void {
    const existing = flushTimers.get(channelId);
    if (existing) {
      clearTimeout(existing);
    }
    flushTimers.set(
      channelId,
      setTimeout(() => {
        flushTimers.delete(channelId);
        void flushNow(channelId);
      }, flushMs),
    );
  }

  /** Warm-only entries keep only their newest rows. */
  function capWarm(
    channelId: string,
    entry: TimelineCacheEntry,
  ): TimelineCacheEntry {
    if (opened.has(channelId) || entry.messages.length <= warmRowCap) {
      return entry;
    }
    const base = full.get(channelId);
    full.set(channelId, base ? mergeFull(base, entry) : entry);
    return {
      ...entry,
      messages: entry.messages.slice(entry.messages.length - warmRowCap),
      // Rows were dropped from the front, so the history start is no longer
      // known to be loaded.
      historyExhausted: false,
    };
  }

  function commit(channelId: string, next: TimelineCacheEntry): void {
    touch(channelId, next);
    notify(channelId, next);
    scheduleFlush(channelId);
  }

  function load(channelId: string): Promise<TimelineCacheEntry> {
    const inMemory = entries.get(channelId);
    if (inMemory) {
      return Promise.resolve(inMemory);
    }
    const pending = loads.get(channelId);
    if (pending) {
      return pending;
    }
    const promise = (async () => {
      const cached = await loadTimelineCache(channelId);
      loads.delete(channelId);
      // Something may have landed while the read was in flight.
      const raced = entries.get(channelId);
      if (raced) {
        return raced;
      }
      const entry = capWarm(channelId, cached ?? emptyTimelineEntry());
      touch(channelId, entry);
      return entry;
    })();
    loads.set(channelId, promise);
    return promise;
  }

  function apply(
    channelId: string,
    event: SignedNostrEvent,
    { source }: { source: TimelineEventSource },
  ): void {
    if (isTimelineCacheEvicted(channelId)) {
      return;
    }
    const warm = isWarmSource(source);
    // Rule 3: the open timeline's sync sub is the only writer there.
    if (warm && (owners.get(channelId) ?? 0) > 0) {
      return;
    }
    const current = entries.get(channelId);
    if (!current) {
      // Never build an entry from nothing: IndexedDB may hold this channel's
      // real history, and a flushed warm-only entry would overwrite it.
      void load(channelId).then(() => apply(channelId, event, { source }));
      return;
    }
    let next = applyEventToEntry(current, event, channelId, {
      mode: warm ? "warm" : "sync",
    });
    if (next === current) {
      return;
    }
    next = capWarm(channelId, next);
    commit(channelId, next);
  }

  return {
    peek(channelId) {
      if (isTimelineCacheEvicted(channelId)) {
        return null;
      }
      return entries.get(channelId) ?? null;
    },
    load,
    apply,
    update(channelId, fn) {
      const current = entries.get(channelId);
      if (!current) {
        return;
      }
      const next = fn(current);
      if (next !== current) {
        commit(channelId, next);
      }
    },
    setOwner(channelId) {
      owners.set(channelId, (owners.get(channelId) ?? 0) + 1);
      opened.add(channelId);
      // Opening restores the full history behind a trimmed warm view.
      const base = full.get(channelId);
      const view = entries.get(channelId);
      full.delete(channelId);
      if (base && view) {
        entries.set(channelId, mergeFull(base, view));
      }
    },
    releaseOwner(channelId) {
      const count = (owners.get(channelId) ?? 0) - 1;
      if (count > 0) {
        owners.set(channelId, count);
      } else {
        owners.delete(channelId);
      }
      if (entries.has(channelId)) {
        void flushNow(channelId);
      }
      evictOverflow();
    },
    isOwned(channelId) {
      return (owners.get(channelId) ?? 0) > 0;
    },
    subscribe(channelId, listener) {
      let bucket = listeners.get(channelId);
      if (!bucket) {
        bucket = new Set();
        listeners.set(channelId, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) {
          listeners.delete(channelId);
        }
      };
    },
    async flushAll() {
      await Promise.all(
        [...new Set([...flushTimers.keys(), ...writeChains.keys()])].map(
          (id) => flushNow(id),
        ),
      );
      await indexChain;
    },
    memoryIds() {
      return [...entries.keys()];
    },
  };
}

/** What a timeline view renders from one store entry. */
export interface FeedSnapshot {
  channelId: string | null;
  messages: MessageBuffer;
  reactions: ReactionIndex;
  historyExhausted: boolean;
}

const EMPTY_MESSAGES: MessageBuffer = [];
const EMPTY_REACTIONS: ReactionIndex = new Map();

export function snapshotOf(
  channelId: string | null,
  entry: TimelineCacheEntry,
): FeedSnapshot {
  return {
    channelId,
    messages: entry.messages,
    reactions: entry.reactions,
    historyExhausted: entry.historyExhausted,
  };
}

/**
 * The first-render state of a timeline view: the store's memory entry when
 * there is one (no blank frame on a switch), else empty. Pure over `peek`.
 */
export function initialFeedState(
  store: Pick<TimelineStore, "peek">,
  channelId: string | null,
): FeedSnapshot {
  const entry = channelId ? store.peek(channelId) : null;
  if (!entry) {
    return {
      channelId,
      messages: EMPTY_MESSAGES,
      reactions: EMPTY_REACTIONS,
      historyExhausted: false,
    };
  }
  return snapshotOf(channelId, entry);
}

/**
 * A warm tap for a feed that already receives kind-9 events: routes each
 * one to its channel's store entry (by `h` tag) under `source`. The store
 * enforces the warm rules; the tap only carries provenance.
 */
export function warmTap(
  store: Pick<TimelineStore, "apply">,
  source: Exclude<TimelineEventSource, "timeline" | "prefetch">,
): (event: SignedNostrEvent) => void {
  return (event) => {
    if (event.kind !== 9) {
      return;
    }
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (channelId) {
      store.apply(channelId, event, { source });
    }
  };
}

/** Capacitor's native bridge marks the iOS shell on the global. */
function nativeIOS(): boolean {
  const capacitor = (
    globalThis as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        getPlatform?: () => string;
      };
    }
  ).Capacitor;
  return (
    capacitor?.isNativePlatform?.() === true &&
    capacitor.getPlatform?.() === "ios"
  );
}

/** The app-wide store. */
export const timelineStore: TimelineStore = createTimelineStore({
  capacity: nativeIOS() ? STORE_CAPACITY_IOS : STORE_CAPACITY,
});
