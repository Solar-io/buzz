import { useMemo } from "react";

import type { ItemRowContext } from "./ui/itemRowContext.ts";
import { useRosters } from "./useItemData.ts";

/**
 * Who can be picked for items in `channelIds`: the people in EVERY one of
 * those channels (roster, plus a DM's participants). An item's owner must be
 * able to see it, and a handoff is posted in each source channel, so a seat
 * outside any of them is not offered. A channel-less item has no roster: it
 * offers the viewer and every agent the shell knows.
 *
 * Read only while `enabled` (the menu or dialog is open).
 */
export function usePickCandidates(
  channelIds: readonly (string | null)[],
  enabled: boolean,
  ctx: Pick<ItemRowContext, "participants" | "knownAgents" | "selfPubkey">,
): { pubkeys: string[]; loading: boolean } {
  const scoped = useMemo(
    () => [...new Set(channelIds)].filter((id): id is string => id !== null),
    [channelIds],
  );
  const hasGlobal = channelIds.includes(null);
  const { rosters, loading } = useRosters(scoped, enabled);
  const pubkeys = useMemo(() => {
    const sets: Set<string>[] = scoped.map(
      (id) =>
        new Set([
          ...(rosters.get(id) ?? []),
          ...ctx.participants(id).map((pubkey) => pubkey.toLowerCase()),
        ]),
    );
    if (hasGlobal) {
      sets.push(
        new Set(
          [...ctx.knownAgents, ...(ctx.selfPubkey ? [ctx.selfPubkey] : [])].map(
            (pubkey) => pubkey.toLowerCase(),
          ),
        ),
      );
    }
    if (sets.length === 0) {
      return [];
    }
    const [first, ...rest] = sets;
    return [...first].filter((pubkey) => rest.every((set) => set.has(pubkey)));
  }, [scoped, hasGlobal, rosters, ctx]);
  return { pubkeys, loading };
}
