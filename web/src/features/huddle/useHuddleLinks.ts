import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  huddleEndedTarget,
  huddleLinkFromEvent,
  huddleRegistryFilters,
  type HuddleLink,
} from "./lib/huddleRegistry.ts";

/**
 * Live map of ephemeral channel id → link, from kind:48100 and kind:48103.
 *
 * Scoped by `#h` over the parent channels, and that is load-bearing rather
 * than an optimisation. The relay resolves subscription scope per REQ, not
 * per filter: `extract_channel_ids_from_filters` returns early the moment a
 * filter carries no `#h`, registering the whole subscription as global, and
 * `fan_out_scoped` then matches a channel-carrying event only against the
 * channel-keyed indexes. Without `#h` this REQ received the historical replay
 * and never another event, so a huddle starting after page load never
 * appeared and one ending never cleared.
 */
export function useHuddleLinks(
  channelIds: readonly string[],
): Map<string, HuddleLink> {
  const { session } = useRelaySession();
  const [links, setLinks] = useState<Map<string, HuddleLink>>(new Map());

  // Channel ids are UUIDs, so a joined string is a lossless set key: the REQ
  // reopens when the SET changes, not on every channel-list re-render.
  const watchedKey = [...channelIds].sort().join(",");

  useEffect(() => {
    const ids = watchedKey ? watchedKey.split(",") : [];
    if (ids.length === 0) {
      return;
    }
    const handlers = {
      onEvent: (event: SignedNostrEvent) => {
        const link = huddleLinkFromEvent(event);
        if (link) {
          setLinks((previous) => {
            const next = new Map(previous);
            next.set(link.ephemeralId, link);
            return next;
          });
          return;
        }
        const ended = huddleEndedTarget(event);
        if (ended) {
          setLinks((previous) => {
            if (!previous.has(ended)) {
              return previous;
            }
            const next = new Map(previous);
            next.delete(ended);
            return next;
          });
        }
      },
    };

    const unsubscribes = huddleRegistryFilters(ids).map((filter) =>
      session.subscribe(filter, handlers),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, watchedKey]);

  return links;
}
