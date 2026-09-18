import { useEffect, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  applyRegistryEvent,
  emptyHuddleRegistryState,
  huddleRegistryFilters,
  type HuddleLink,
} from "./lib/huddleRegistry.ts";

/**
 * Live huddle registry folded from kind:48100 (started) and kind:48103
 * (ended) events: which ephemeral rooms are joinable, which are over, and
 * whether the feed has replayed at least once.
 *
 * Scoped by `#h` over the parent channels, and that is load-bearing rather
 * than an optimisation. The relay resolves subscription scope per REQ, not
 * per filter: `extract_channel_ids_from_filters` returns early the moment a
 * filter carries no `#h`, registering the whole subscription as global, and
 * `fan_out_scoped` then matches a channel-carrying event only against the
 * channel-keyed indexes. Without `#h` this REQ received the historical replay
 * and never another event, so a huddle starting after page load never
 * appeared and one ending never cleared.
 *
 * The fold itself (`applyRegistryEvent`) is ORDER-INSENSITIVE: the relay
 * replays newest first, so a cold load delivers each ended huddle's 48103
 * BEFORE its 48100. The ended set recorded from the end event is what stops
 * the later start event from resurrecting a room the relay had already
 * retired (the V1b dead-join defect). `ended` therefore carries huddles the
 * `links` map has never seen, and `resolved` reports that every chunk REQ
 * has come back EOSE at least once — the point after which "no link" means
 * the relay has no record, not that the replay is still in flight.
 */
export function useHuddleLinks(channelIds: readonly string[]): {
  /** Live (not ended) links: ephemeral channel id → link. */
  links: Map<string, HuddleLink>;
  /** Ephemeral channel ids the registry has seen ended. */
  ended: Set<string>;
  /** True once every chunk REQ has delivered its EOSE at least once. */
  resolved: boolean;
} {
  const { session } = useRelaySession();
  const [state, setState] = useState(emptyHuddleRegistryState);
  const [resolved, setResolved] = useState(false);
  // Chunks still waiting for their first EOSE. A ref because the EOSE
  // handler closes over it without re-subscribing; the count is only read
  // to decide when `resolved` flips.
  const pendingEoseRef = useRef(0);

  // Channel ids are UUIDs, so a joined string is a lossless set key: the REQ
  // reopens when the SET changes, not on every channel-list re-render.
  const watchedKey = [...channelIds].sort().join(",");

  useEffect(() => {
    const ids = watchedKey ? watchedKey.split(",") : [];
    if (ids.length === 0) {
      setResolved(false);
      pendingEoseRef.current = 0;
      return;
    }
    const filters = huddleRegistryFilters(ids);
    pendingEoseRef.current = filters.length;
    setResolved(false);
    setState(emptyHuddleRegistryState());
    const handlers = {
      onEvent: (event: SignedNostrEvent) => {
        setState((previous) => applyRegistryEvent(previous, event));
      },
      onEose: () => {
        pendingEoseRef.current -= 1;
        if (pendingEoseRef.current <= 0) {
          setResolved(true);
        }
      },
    };

    const unsubscribes = filters.map((filter) =>
      session.subscribe(filter, handlers),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, watchedKey]);

  return { links: state.links, ended: state.ended, resolved };
}
