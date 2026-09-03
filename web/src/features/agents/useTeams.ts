import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import {
  mergeTeam,
  teamFromEvent,
  type TeamView,
} from "@/features/agents/lib/teamEvents";

/**
 * The owner's kind-30176 teams, live from the relay — the read-only source
 * for the teams panel and roster badges. Replaceable events, newest-wins per
 * team id (d tag = team id).
 *
 * AUTHOR-SCOPED ON PURPOSE (Phase 3 §0.3 risk decision): 30176 is not
 * shared-gated today (kind.rs calls that an acknowledged gap), but the web
 * subscribes `authors:[self]` regardless — the page is the owner's own
 * teams view, and author-scoping survives any future owner-private read
 * tightening. Community team browsing is explicitly NOT built.
 */
export function useTeams(): Map<string, TeamView> {
  const { session, status } = useRelaySession();
  const [teams, setTeams] = useState<Map<string, TeamView>>(() => new Map());

  useEffect(() => {
    if (!session || status !== "open") {
      return;
    }
    let alive = true;
    let cleanup: (() => void) | null = null;
    void ownPubkey().then((pubkey) => {
      if (!alive || !pubkey) {
        return;
      }
      cleanup = session.subscribe(
        { kinds: [30176], authors: [pubkey], limit: 100 },
        {
          onEvent: (event) => {
            const team = teamFromEvent(event);
            if (team) {
              setTeams((previous) => mergeTeam(previous, team));
            }
          },
        },
      );
    });
    return () => {
      alive = false;
      cleanup?.();
    };
  }, [session, status]);

  return teams;
}
