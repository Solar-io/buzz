import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ChannelSummary } from "@/features/channels/useChannels";
import { useSettledKey } from "@/features/work/lib/useSettledKey.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { parseShare, type Share } from "./lib/shareEvent.ts";
import { shelfFilters } from "./lib/shelfQuery.ts";
import { newShareCount, sortShares } from "./lib/shelfView.ts";

/**
 * Every file shared in the viewer's conversations, subscribed ONCE for the
 * shell (the ItemsProvider discipline): the Shelf page, the sidebar's "N new"
 * and a file tab's path lookup all read this one map.
 *
 * Shares are kind 9 messages, so they are channel-scoped: each 128-channel
 * chunk is its own REQ carrying `#h` (history AND live — AGENTS.md gotcha
 * 11) and `#t:["shelf"]`, which the relay pushes into SQL before the limit.
 */

export interface ShelfContextValue {
  /** Newest first. */
  shares: Share[];
  byId: ReadonlyMap<string, Share>;
  /** Every chunk answered (or the relay is not being served). */
  loaded: boolean;
  /** The Shelf page is on screen: everything up to now is seen. */
  markSeen: () => void;
}

const ShelfContext = createContext<ShelfContextValue | null>(null);
const ShelfNewContext = createContext<number>(0);

const SEEN_KEY = "buzz.shelf.seen.v1";
const INGEST_FLUSH_MS = 40;

function loadSeen(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY);
    const value = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function saveSeen(at: number): void {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, String(at));
  } catch {
    // Best effort: the badge simply counts from the old mark.
  }
}

export function ShelfProvider({
  channels,
  selfPubkey,
  children,
}: {
  channels: readonly ChannelSummary[];
  selfPubkey: string | null;
  children: ReactNode;
}) {
  const { session, status } = useRelaySession();
  const live = status !== "idle" && selfPubkey !== null;
  const [byId, setById] = useState<ReadonlyMap<string, Share>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  const [seenAt, setSeenAt] = useState<number | null>(() => loadSeen());
  const buffer = useRef<Share[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const arrived = buffer.current;
    buffer.current = [];
    if (arrived.length === 0) {
      return;
    }
    setById((previous) => {
      let next: Map<string, Share> | null = null;
      for (const share of arrived) {
        if (previous.has(share.id) || next?.has(share.id)) {
          continue;
        }
        next ??= new Map(previous);
        next.set(share.id, share);
      }
      return next ?? previous;
    });
  }, []);
  const receive = useCallback(
    (event: SignedNostrEvent) => {
      const share = parseShare(event);
      if (!share) {
        return;
      }
      buffer.current.push(share);
      timer.current ??= setTimeout(flush, INGEST_FLUSH_MS);
    },
    [flush],
  );
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const channelKey = useSettledKey(
    channels
      .filter((channel) => !channel.archived)
      .map((channel) => channel.id)
      .sort()
      .join(","),
  );
  useEffect(() => {
    if (!live) {
      return;
    }
    // A relay that never answers — or a viewer with no channels at all —
    // must not leave the page on its skeleton.
    const fallback = setTimeout(() => setLoaded(true), 12_000);
    if (channelKey === "") {
      return () => clearTimeout(fallback);
    }
    const filters = shelfFilters(channelKey.split(","));
    let pending = filters.length;
    const unsubscribes = filters.map((filter) =>
      session.subscribe(filter, {
        onEvent: receive,
        onEose: () => {
          pending -= 1;
          if (pending <= 0) {
            setLoaded(true);
          }
        },
      }),
    );
    return () => {
      clearTimeout(fallback);
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, live, channelKey, receive]);

  const shares = useMemo(() => sortShares([...byId.values()]), [byId]);
  const newestAt = shares[0]?.createdAt ?? 0;
  const markSeen = useCallback(() => {
    const at = Math.max(newestAt, Math.floor(Date.now() / 1000));
    saveSeen(at);
    setSeenAt(at);
  }, [newestAt]);

  const value = useMemo<ShelfContextValue>(
    () => ({ shares, byId, loaded, markSeen }),
    [shares, byId, loaded, markSeen],
  );
  const fresh = newShareCount(
    shares,
    seenAt,
    selfPubkey,
    Math.floor(Date.now() / 1000),
  );
  return (
    <ShelfContext.Provider value={value}>
      <ShelfNewContext.Provider value={fresh}>
        {children}
      </ShelfNewContext.Provider>
    </ShelfContext.Provider>
  );
}

/** Null outside ShelfProvider (a component test that mounts a tile alone). */
export function useShelf(): ShelfContextValue | null {
  return useContext(ShelfContext);
}

/** The sidebar row's "N new" — changes only when the number does. */
export function useShelfNewCount(): number {
  return useContext(ShelfNewContext);
}
