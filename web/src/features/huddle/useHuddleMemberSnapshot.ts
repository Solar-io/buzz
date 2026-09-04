import { useCallback, useEffect, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  huddleMemberSnapshotFilter,
  membersFromMemberEvent,
} from "./lib/huddleMembers.ts";

/**
 * One channel's roster (pubkey → role), refreshed by REPEATED one-shot REQs.
 *
 * The polling is not laziness, it is the only thing that works, and it was
 * measured rather than assumed. Against a live relay:
 *
 *   REQ {kinds:[39002], "#d":[channel]}      → snapshot arrives, EOSE
 *   EVENT kind:9000 add-member role=bot      → OK true
 *   ...nothing on the open subscription...
 *   REQ {kinds:[39002], "#d":[channel]}      → snapshot NOW carries
 *                                              ["p", agent, "", "bot"]
 *
 * The relay does re-sign the snapshot on every membership change
 * (`store_group_members_event`, crates/buzz-relay/src/handlers/side_effects.rs:1052);
 * it just never reaches that subscription. Scope is resolved PER REQ from `#h`
 * alone, so a `#d`-only filter registers the whole subscription as GLOBAL,
 * while the stored 39002 carries a channel id and is therefore matched only
 * against the channel-keyed indexes (`fan_out_scoped`,
 * crates/buzz-relay/src/subscription.rs:387). Adding `#h` would not rescue it:
 * a 39002's tags are `d` and `p`, so the filter would then match nothing.
 *
 * The desktop has the same constraint and answers it the same way — it
 * re-fetches the huddle's agent pubkeys on a 30s timer
 * (`AGENT_PUBKEY_REFRESH_INTERVAL_MS`,
 * desktop/src/features/huddle/lib/useTtsSubscription.ts:19) rather than
 * trusting a live subscription.
 *
 * `merge` exists so a client that just published an add does not have to wait
 * out a poll interval to see its own effect.
 */

/** Cadence of the snapshot re-REQ. Half the desktop's, since a huddle is short. */
export const MEMBER_SNAPSHOT_REFRESH_MS = 15_000;

export interface HuddleMemberSnapshot {
  /** pubkey (lowercase) → role. Empty until the first snapshot arrives. */
  members: ReadonlyMap<string, string>;
  /** False until a snapshot for THIS channel has been read at least once. */
  known: boolean;
  /** Fold a locally-known member in ahead of the next poll. */
  merge: (pubkey: string, role: string) => void;
}

export function useHuddleMemberSnapshot(
  channelId: string | null,
  refreshMs: number = MEMBER_SNAPSHOT_REFRESH_MS,
): HuddleMemberSnapshot {
  const { session } = useRelaySession();
  const [members, setMembers] = useState<ReadonlyMap<string, string>>(
    () => new Map<string, string>(),
  );
  const [known, setKnown] = useState(false);
  // Locally-published adds, replayed over every poll result until the relay's
  // own snapshot catches up and makes them redundant.
  const optimisticRef = useRef(new Map<string, string>());

  useEffect(() => {
    setMembers(new Map<string, string>());
    setKnown(false);
    optimisticRef.current = new Map<string, string>();
    if (!channelId) {
      return;
    }

    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const openRequest = () => {
      unsubscribe?.();
      unsubscribe = session.subscribe(huddleMemberSnapshotFilter(channelId), {
        onEvent: (event) => {
          if (disposed) {
            return;
          }
          const parsed = membersFromMemberEvent(event, channelId);
          if (parsed === null) {
            return;
          }
          for (const [pubkey, role] of optimisticRef.current) {
            if (!parsed.has(pubkey)) {
              parsed.set(pubkey, role);
            } else {
              // The relay agrees now, so stop carrying our guess.
              optimisticRef.current.delete(pubkey);
            }
          }
          setMembers(parsed);
          setKnown(true);
        },
      });
    };

    openRequest();
    const timer = window.setInterval(openRequest, refreshMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [session, channelId, refreshMs]);

  const merge = useCallback((pubkey: string, role: string) => {
    const key = pubkey.toLowerCase();
    optimisticRef.current.set(key, role);
    setMembers((previous) => {
      if (previous.get(key) === role) {
        return previous;
      }
      const next = new Map(previous);
      next.set(key, role);
      return next;
    });
  }, []);

  return { members, known, merge };
}
