/**
 * One relay subscription shared by every consumer of the same filter.
 *
 * The moderation gate is evaluated per message row, and a row-local
 * `session.subscribe` would open one REQ per rendered message — dozens of
 * duplicate subscriptions for a single answer the relay would give once. The
 * relay closes a connection as a slow client under sustained REQ pressure
 * (see `REQ_OPEN_PACE_MS` in relay-session.ts), so this is a correctness
 * concern, not only tidiness.
 *
 * So: one entry per key, reference-counted, holding the newest event seen for
 * that filter. The subscription opens on the first subscriber and closes on
 * the last. Both kinds this backs (13534, 39001) are replaceable/addressable,
 * so "newest by `created_at`" is the whole reduction — ties keep the incumbent,
 * which makes a relay that re-sends the same snapshot a no-op rather than a
 * render.
 */

import type { NostrFilter } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { RelaySession, Unsubscribe } from "@/shared/api/relay-session";

interface Entry {
  refs: number;
  event: SignedNostrEvent | null;
  unsubscribe: Unsubscribe | null;
  listeners: Set<() => void>;
}

/**
 * Keyed by session identity as well as filter key: a community switch builds a
 * new `RelaySession`, and the previous community's snapshot must not answer
 * for the new one.
 */
const entriesBySession = new WeakMap<RelaySession, Map<string, Entry>>();

function entriesFor(session: RelaySession): Map<string, Entry> {
  let map = entriesBySession.get(session);
  if (!map) {
    map = new Map();
    entriesBySession.set(session, map);
  }
  return map;
}

/**
 * Current snapshot for `key`, or null when nothing has arrived yet. Stable by
 * reference between arrivals, so it is safe as a `useSyncExternalStore`
 * snapshot.
 */
export function latestEvent(
  session: RelaySession,
  key: string,
): SignedNostrEvent | null {
  return entriesFor(session).get(key)?.event ?? null;
}

/**
 * Join the shared subscription for `key`, opening it if this is the first
 * subscriber. `onChange` fires whenever the stored snapshot is replaced. The
 * returned handle releases this consumer's reference; the REQ closes when the
 * last one leaves.
 */
export function subscribeLatestEvent(
  session: RelaySession,
  key: string,
  filter: NostrFilter,
  onChange: () => void,
): Unsubscribe {
  const entries = entriesFor(session);
  let entry = entries.get(key);
  if (!entry) {
    entry = { refs: 0, event: null, unsubscribe: null, listeners: new Set() };
    entries.set(key, entry);
  }
  const active = entry;
  active.refs += 1;
  active.listeners.add(onChange);

  if (!active.unsubscribe) {
    active.unsubscribe = session.subscribe(filter, {
      onEvent: (event) => {
        const current = active.event;
        if (current && current.created_at >= event.created_at) {
          return;
        }
        active.event = event;
        for (const listener of active.listeners) {
          listener();
        }
      },
    });
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    active.listeners.delete(onChange);
    active.refs -= 1;
    if (active.refs > 0) {
      return;
    }
    active.unsubscribe?.();
    active.unsubscribe = null;
    // The snapshot is dropped with the last consumer rather than cached: it is
    // relay state, and a stale role read is exactly the failure this gate must
    // not have. The next mount re-reads it.
    entries.delete(key);
  };
}

/** Test seam: forget every shared subscription for a session. */
export function resetSharedEvents(session: RelaySession): void {
  const entries = entriesBySession.get(session);
  if (!entries) {
    return;
  }
  for (const entry of entries.values()) {
    entry.unsubscribe?.();
  }
  entries.clear();
}
