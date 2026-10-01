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
import { queryOnce } from "@/features/pulse/lib/relayQuery.ts";
import { useSettledKey } from "@/features/work/lib/useSettledKey.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  foldItems,
  headKey,
  type ItemHead,
  itemKey,
  KIND_ITEM,
  supersedes,
} from "./lib/itemEvent.ts";
import {
  itemsHistoryFilter,
  itemsLiveFilters,
  nextPageUntil,
} from "./lib/itemQueries.ts";
import { openCounts } from "./lib/itemsView.ts";

/**
 * Items (kind 30623) for the whole shell, subscribed ONCE (the WorkProvider
 * discipline): the Items page, the sidebar row's counts, the `/bug` project
 * guess and every confirmation row in a timeline read this one fold.
 *
 * Heads are kept newest-per-author (addressable events are per author), and
 * folded per `(h, d)` into items (D5.4). Arrivals are buffered and applied in
 * one state update: the first page is up to a thousand events, and a
 * setState per event would re-fold a thousand times.
 */

export interface ItemsContextValue {
  /** Folded items (fold order: newest change first). */
  items: ItemHead[];
  /** Items by fold key (`itemKey(h, d)`) — confirmation rows look up here. */
  byKey: ReadonlyMap<string, ItemHead>;
  /** The first page has arrived (or the relay is not being served). */
  loaded: boolean;
  /** Apply a head this client just published, without waiting for the echo. */
  ingest: (event: SignedNostrEvent) => void;
  /** Drop heads this client deleted (Undo). */
  forget: (eventIds: readonly string[]) => void;
  /** Heads the fold can use, for the command host (never a snapshot). */
  latest: () => ItemHead[];
}

export interface ItemCounts {
  bugs: number;
  backlog: number;
}

const ItemsContext = createContext<ItemsContextValue | null>(null);
const ItemCountsContext = createContext<ItemCounts | null>(null);

/** How long arrivals collect before one state update applies them. */
const INGEST_FLUSH_MS = 40;

export function ItemsProvider({
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
  const [heads, setHeads] = useState<ReadonlyMap<string, SignedNostrEvent>>(
    () => new Map(),
  );
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loaded, setLoaded] = useState(false);
  const buffer = useRef<SignedNostrEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const arrived = buffer.current;
    buffer.current = [];
    if (arrived.length === 0) {
      return;
    }
    setHeads((previous) => {
      let next: Map<string, SignedNostrEvent> | null = null;
      for (const event of arrived) {
        const key = headKey(event);
        const current = (next ?? previous).get(key);
        if (current && !supersedes(event, current)) {
          continue;
        }
        next ??= new Map(previous);
        next.set(key, event);
      }
      return next ?? previous;
    });
  }, []);

  const receive = useCallback(
    (event: SignedNostrEvent) => {
      if (event.kind !== KIND_ITEM) {
        return;
      }
      buffer.current.push(event);
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

  // ---- history (+ live global items), paged back while pages come full ----
  useEffect(() => {
    if (!live) {
      return;
    }
    let alive = true;
    let pageSize = 0;
    let pageOldest = Number.POSITIVE_INFINITY;
    const pageBack = async (firstUntil: number) => {
      let until: number | null = firstUntil;
      for (let pages = 1; until !== null && alive; pages += 1) {
        const page = await queryOnce(session, itemsHistoryFilter(until));
        if (!alive) {
          return;
        }
        let oldest = Number.POSITIVE_INFINITY;
        for (const event of page) {
          receive(event);
          oldest = Math.min(oldest, event.created_at);
        }
        until = nextPageUntil({
          pageSize: page.length,
          pageOldest: oldest,
          previousUntil: until,
          pagesFetched: pages,
        });
      }
    };
    const unsubscribe = session.subscribe(itemsHistoryFilter(), {
      onEvent: (event) => {
        pageSize += 1;
        pageOldest = Math.min(pageOldest, event.created_at);
        receive(event);
      },
      onEose: () => {
        setLoaded(true);
        const until = nextPageUntil({
          pageSize,
          pageOldest,
          previousUntil: null,
          pagesFetched: 0,
        });
        pageSize = Number.NEGATIVE_INFINITY; // live arrivals are not a page
        if (until !== null) {
          void pageBack(until);
        }
      },
    });
    // A relay that never answers must not leave the page on its skeleton.
    const fallback = setTimeout(() => setLoaded(true), 12_000);
    return () => {
      alive = false;
      clearTimeout(fallback);
      unsubscribe();
    };
  }, [session, live, receive]);

  // ---- live channel-scoped items: every readable channel rides in #h ------
  const channelKey = useSettledKey(
    channels
      .filter((channel) => !channel.archived)
      .map((channel) => channel.id)
      .sort()
      .join(","),
  );
  useEffect(() => {
    if (!live || channelKey === "") {
      return;
    }
    const unsubscribes = itemsLiveFilters(
      channelKey.split(","),
      Math.floor(Date.now() / 1000),
    ).map((filter) => session.subscribe(filter, { onEvent: receive }));
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, live, channelKey, receive]);

  const items = useMemo(
    () =>
      foldItems(
        [...heads.values()].filter((event) => !forgotten.has(event.id)),
      ),
    [heads, forgotten],
  );
  const byKey = useMemo(
    () =>
      new Map(items.map((item) => [itemKey(item.channelId, item.id), item])),
    [items],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const ingest = useCallback(
    (event: SignedNostrEvent) => {
      receive(event);
      if (timer.current) {
        clearTimeout(timer.current);
      }
      flush();
    },
    [receive, flush],
  );
  const forget = useCallback((eventIds: readonly string[]) => {
    setForgotten((previous) => new Set([...previous, ...eventIds]));
  }, []);
  const latest = useCallback(() => itemsRef.current, []);

  const value = useMemo<ItemsContextValue>(
    () => ({ items, byKey, loaded, ingest, forget, latest }),
    [items, byKey, loaded, ingest, forget, latest],
  );
  const { bugs, backlog } = openCounts(items);
  const counts = useMemo(() => ({ bugs, backlog }), [bugs, backlog]);
  return (
    <ItemsContext.Provider value={value}>
      <ItemCountsContext.Provider value={counts}>
        {children}
      </ItemCountsContext.Provider>
    </ItemsContext.Provider>
  );
}

/** Null outside ItemsProvider (a component test that mounts a row alone). */
export function useItems(): ItemsContextValue | null {
  return useContext(ItemsContext);
}

/**
 * The sidebar row's numbers — a value that changes only when a count does,
 * so the sidebar does not re-render on every item edit.
 */
export function useItemCounts(): ItemCounts | null {
  return useContext(ItemCountsContext);
}
