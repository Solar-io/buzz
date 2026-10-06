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
export type ActivitySession = Pick<RelaySession, "subscribe">;

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
  /** Point the feed; re-subscribes only when session, ids or viewer change. */
  setFeed(feed: ConversationFeed): void;
  /** Read markers advanced: zero, then recount, the moved conversations. */
  markersMoved(previous: ReadState, next: ReadState): void;
  /** Close every subscription (the store can be fed again). */
  dispose(): void;
}

interface Batch {
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
}): ConversationActivityStore {
  const listeners = new Set<() => void>();
  const arrivalHandlers = new Set<ArrivalHandler>();
  const activityRef: { current: ChannelActivityMap } = { current: new Map() };
  let counts: ChannelUnreadCounts = new Map();
  let batches: Batch[] = [];
  let feedKey: string | null = null;
  let feedSession: ActivitySession | null = null;
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
      settled: batches.every((batch) => batch.settled),
      criticalSettled: batches.every(
        (batch) => !batch.critical || batch.settled,
      ),
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

  const unsubscribeAll = () => {
    for (const batch of batches) batch.unsubscribe();
    batches = [];
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
      const critical = uniqueSorted(criticalIds);
      const rest = uniqueSorted(ids).filter((id) => !critical.includes(id));
      const key = session
        ? `${critical.join(",")}|${rest.join(",")}|${selfPubkey ?? ""}`
        : null;
      if (key === feedKey && session === feedSession) {
        return;
      }
      unsubscribeAll();
      feedKey = key;
      feedSession = session;
      // Keep what is known about conversations still in the feed: a re-REQ
      // re-derives counts at its EOSE, and until then rows keep their state
      // instead of flickering to read.
      const keep = new Set([...critical, ...rest]);
      activityRef.current = filterMap(activityRef.current, keep);
      counts = filterMap(counts, keep);
      if (session) {
        const markers = options.readMarkers();
        const groups: Array<[string[], boolean]> = [
          [critical, true],
          [rest, false],
        ];
        for (const [groupIds, isCritical] of groups) {
          for (const filters of channelActivityFilterBatches(
            groupIds,
            markers,
          )) {
            const batch: Batch = {
              critical: isCritical,
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
                selfPubkey,
                onRawEvent: options.onRawEvent,
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
              priority: isCritical ? "critical" : undefined,
            });
            batches.push(batch);
          }
        }
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
      feedKey = null;
      feedSession = null;
    },
  };
}

function uniqueSorted(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort();
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
