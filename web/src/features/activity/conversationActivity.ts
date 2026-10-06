/**
 * The conversation-activity store (LEFT_NAV_ARCHITECTURE_REVIEW.md §3).
 *
 * ONE owner of "new since you looked" for every conversation — stream,
 * forum and DM alike — fed by ONE batched subscription family. Toasts, the
 * sidebar rows, their unread pills, the phone tab badge and the DM list's
 * recency all read it. Before this, a DM row and its toast came from two
 * twin subscriptions with two different definitions of "live", and its pill
 * from a third one-shot REQ per row that never updated after EOSE.
 *
 * Framework-free: React reads it through useSyncExternalStore
 * (useConversationActivity.ts); the node tests drive it directly.
 *
 * Invariants it carries:
 * - I1 toast ⇒ row: an arrival handler runs only after the snapshot already
 *   holds the arrival, so whatever it shows, the row shows too.
 * - I2 one "live": the counting handlers' rule (channelActivity.ts).
 * - I4 one count: the same window drives every row's pill.
 */

import {
  MAX_FILTERS_PER_REQ,
  channelActivityFilterBatches,
  createChannelActivityHandlers,
  resetCountsForMarkerChanges,
  type ChannelActivity,
  type ChannelActivityMap,
  type ChannelActivitySubscriptionHandlers,
  type ChannelUnreadCounts,
} from "@/features/channels/lib/channelActivity.ts";
import type { ReadState } from "@/features/channels/lib/readState.ts";
import type { RelaySession, Unsubscribe } from "@/shared/api/relay-session";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/** The slice of RelaySession the store needs. */
export type ActivitySession = Pick<RelaySession, "subscribe"> &
  Partial<Pick<RelaySession, "onConnectionLost">>;

/**
 * Additions after the first build are coalesced this long, so a channel
 * list that streams in (a fresh login) opens a few packed batches instead
 * of one REQ per new conversation.
 */
export const ADD_COALESCE_MS = 200;

export interface ConversationActivitySnapshot {
  /** Newest sampled kind-9 per conversation (self-authored included). */
  activity: ChannelActivityMap;
  /** Foreign messages newer than the marker, once a window has derived. */
  unreadCounts: ChannelUnreadCounts;
  /** Every batch of the current feed reached its first EOSE. */
  settled: boolean;
  /** Every CRITICAL batch (the DMs) reached its first EOSE. */
  criticalSettled: boolean;
}

export interface ConversationFeed {
  session: ActivitySession | null;
  /** Conversations opened first in the post-AUTH replay (the DMs). */
  criticalIds: readonly string[];
  /** Everything else (channels, forums). */
  ids: readonly string[];
  selfPubkey: string | null;
}

export type ArrivalHandler = (entry: ChannelActivity) => void;

export interface ConversationActivityStore {
  getSnapshot(): ConversationActivitySnapshot;
  subscribe(listener: () => void): () => void;
  /** Register for live arrivals (I2). Returns the unregister. */
  onArrival(handler: ArrivalHandler): () => void;
  /**
   * Point the feed. A new session or viewer rebuilds every batch; otherwise
   * only batches holding a conversation that left reopen, and new
   * conversations get batches of their own (coalesced, ADD_COALESCE_MS).
   */
  setFeed(feed: ConversationFeed): void;
  /** Read markers advanced: zero, then recount, the moved conversations. */
  markersMoved(previous: ReadState, next: ReadState): void;
  /** Close every subscription (the store can be fed again). */
  dispose(): void;
}

interface Batch {
  ids: readonly string[];
  handlers: ChannelActivitySubscriptionHandlers;
  critical: boolean;
  settled: boolean;
  unsubscribe: Unsubscribe;
}

export function createConversationActivityStore(options: {
  /** Current read markers, read at every count decision. */
  readMarkers: () => ReadState;
  /** Every raw kind-9 the feed carries (the timeline warm tap). */
  onRawEvent?: (event: SignedNostrEvent) => void;
  /** Clock, unix ms (tests). */
  now?: () => number;
}): ConversationActivityStore {
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const arrivalHandlers = new Set<ArrivalHandler>();
  const activityRef: { current: ChannelActivityMap } = { current: new Map() };
  let counts: ChannelUnreadCounts = new Map();
  let batches: Batch[] = [];
  /** Session + viewer the open batches were built for. */
  let feedSession: ActivitySession | null = null;
  let feedSelf: string | null = null;
  let offConnectionLost: () => void = () => {};
  /**
   * When this feed started listening (unix s): a message created since is
   * news even if it reaches a batch before that batch's first EOSE.
   */
  let liveSince: number | undefined;
  /** Ids waiting for the coalesced add, per group. */
  const pending = { critical: new Set<string>(), rest: new Set<string>() };
  let addTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: ConversationActivitySnapshot = {
    activity: activityRef.current,
    unreadCounts: counts,
    settled: true,
    criticalSettled: true,
  };
  let dirty = false;
  let pendingArrivals: ChannelActivity[] = [];

  const rebuild = () => {
    snapshot = {
      activity: activityRef.current,
      unreadCounts: counts,
      settled:
        pending.critical.size === 0 &&
        pending.rest.size === 0 &&
        batches.every((batch) => batch.settled),
      criticalSettled:
        pending.critical.size === 0 &&
        batches.every((batch) => !batch.critical || batch.settled),
    };
  };
  // One notification per delivered frame, then the arrivals it produced:
  // a handler that reads the store sees the arrival's own state (I1).
  const flush = () => {
    if (dirty) {
      dirty = false;
      rebuild();
      for (const listener of listeners) listener();
    }
    const arrivals = pendingArrivals;
    pendingArrivals = [];
    for (const entry of arrivals) {
      for (const handler of arrivalHandlers) handler(entry);
    }
  };

  const clearPending = () => {
    pending.critical.clear();
    pending.rest.clear();
    if (addTimer !== null) {
      clearTimeout(addTimer);
      addTimer = null;
    }
  };

  const unsubscribeAll = () => {
    for (const batch of batches) batch.unsubscribe();
    batches = [];
    clearPending();
    offConnectionLost();
    offConnectionLost = () => {};
  };

  /** Open packed batches (≤10 filters each) for `ids` on the feed session. */
  const openBatches = (ids: readonly string[], critical: boolean) => {
    const session = feedSession;
    if (!session || ids.length === 0) return;
    const markers = options.readMarkers();
    const sorted = [...ids].sort();
    const filterBatches = channelActivityFilterBatches(sorted, markers);
    filterBatches.forEach((filters, index) => {
      const batch: Batch = {
        ids: sorted.slice(
          index * MAX_FILTERS_PER_REQ,
          (index + 1) * MAX_FILTERS_PER_REQ,
        ),
        critical,
        settled: false,
        unsubscribe: () => {},
        handlers: createChannelActivityHandlers({
          activityRef,
          onActivityChange: () => {
            dirty = true;
          },
          onLiveArrival: (entry) => pendingArrivals.push(entry),
          onUnreadCountsChange: (updater) => {
            const next = updater(counts);
            if (next !== counts) {
              counts = next;
              dirty = true;
            }
          },
          readMarkers: options.readMarkers,
          selfPubkey: feedSelf,
          onRawEvent: options.onRawEvent,
          liveSince,
        }),
      };
      batch.unsubscribe = session.subscribe(filters, {
        onEvent: (event) => {
          batch.handlers.onEvent(event);
          flush();
        },
        onEose: () => {
          batch.handlers.onEose();
          if (!batch.settled) {
            batch.settled = true;
            dirty = true;
          }
          flush();
        },
        priority: critical ? "critical" : undefined,
      });
      batches.push(batch);
    });
  };

  const flushPendingAdds = () => {
    addTimer = null;
    const critical = [...pending.critical];
    const rest = [...pending.rest];
    pending.critical.clear();
    pending.rest.clear();
    openBatches(critical, true);
    openBatches(rest, false);
    dirty = true;
    flush();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onArrival(handler) {
      arrivalHandlers.add(handler);
      return () => {
        arrivalHandlers.delete(handler);
      };
    },
    setFeed({ session, criticalIds, ids, selfPubkey }) {
      const critical = new Set(criticalIds);
      const rest = new Set([...ids].filter((id) => !critical.has(id)));
      const wanted = (id: string, isCritical: boolean) =>
        isCritical ? critical.has(id) : rest.has(id);
      // Keep what is known about conversations still in the feed.
      const keep = new Set([...critical, ...rest]);
      activityRef.current = filterMap(activityRef.current, keep);
      counts = filterMap(counts, keep);

      if (session !== feedSession || selfPubkey !== feedSelf) {
        // A new socket owner or viewer: every batch is rebuilt.
        unsubscribeAll();
        feedSession = session;
        feedSelf = selfPubkey;
        if (session) {
          liveSince ??= Math.floor(now() / 1000);
          offConnectionLost =
            session.onConnectionLost?.(() => {
              for (const batch of batches) batch.handlers.beginReplay();
            }) ?? (() => {});
          openBatches([...critical], true);
          openBatches([...rest], false);
        }
        dirty = true;
        flush();
        return;
      }
      if (!session) return;

      // Same session and viewer: never touch a batch whose conversations
      // are all still wanted (QA #8 — adding one DM used to re-subscribe
      // every batch and push its first message into a backfill round).
      const covered = new Set<string>();
      const survivors: Batch[] = [];
      for (const batch of batches) {
        if (batch.ids.every((id) => wanted(id, batch.critical))) {
          survivors.push(batch);
          for (const id of batch.ids) covered.add(id);
        } else {
          // A conversation left (or changed group): only this batch reopens.
          batch.unsubscribe();
        }
      }
      batches = survivors;
      for (const id of [...pending.critical]) {
        if (!critical.has(id)) pending.critical.delete(id);
      }
      for (const id of [...pending.rest]) {
        if (!rest.has(id)) pending.rest.delete(id);
      }
      for (const id of critical) {
        if (!covered.has(id)) pending.critical.add(id);
      }
      for (const id of rest) {
        if (!covered.has(id)) pending.rest.add(id);
      }
      if (
        (pending.critical.size > 0 || pending.rest.size > 0) &&
        addTimer === null
      ) {
        addTimer = setTimeout(flushPendingAdds, ADD_COALESCE_MS);
      }
      dirty = true;
      flush();
    },
    markersMoved(previous, next) {
      const reset = resetCountsForMarkerChanges(counts, previous, next);
      if (reset !== counts) {
        counts = reset;
        dirty = true;
      }
      const advanced = Object.keys(next).filter(
        (id) => (previous[id] ?? 0) < (next[id] ?? 0),
      );
      if (advanced.length > 0) {
        for (const batch of batches) batch.handlers.recount(advanced);
      }
      flush();
    },
    dispose() {
      unsubscribeAll();
      feedSession = null;
      feedSelf = null;
    },
  };
}

function filterMap<V>(map: Map<string, V>, keep: Set<string>): Map<string, V> {
  let changed = false;
  const next = new Map<string, V>();
  for (const [id, value] of map) {
    if (keep.has(id)) {
      next.set(id, value);
    } else {
      changed = true;
    }
  }
  return changed ? next : map;
}
