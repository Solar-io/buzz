import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { getUnlockedSecretKey } from "@/shared/lib/key-store";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { getPublicKey } from "nostr-tools/pure";

import { buildMemoryGraph, type MemoryGraph } from "./lib/buildMemoryGraph.ts";
import {
  decodeEngramListing,
  ENGRAM_KIND,
  type AgentMemoryListing,
} from "./lib/engrams.ts";

/**
 * Read-only NIP-AE memory viewer for the web client — the desktop's
 * `features/agent-memory/hooks.ts`, reimplemented over a direct relay REQ
 * instead of the `get_agent_memory` Tauri command.
 *
 * The desktop keeps the owner's secret key in Rust and decrypts there. The
 * web has no such boundary, so it does the REQ + NIP-44 decrypt in the
 * browser with the viewer's own unlocked key. That is the same trust model:
 * every engram is encrypted to the OWNER, so the owner's key is the only one
 * that can open it, and the agent's key is never involved.
 */

/**
 * Events requested per (agent, owner) pair.
 *
 * Pinned to the relay's own page clamp — `buzz_db::DEFAULT_MAX_PAGE_LIMIT`
 * (1000) in `crates/buzz-db/src/event.rs`, which `query_events` applies as
 * `min(requested, clamp)`. Asking for more cannot return more, and asking
 * for more is how truncation detection breaks: the desktop asks for 5000 and
 * therefore never sees `received >= requested`, so its "list may be
 * incomplete" warning cannot fire against this relay. Requesting exactly the
 * clamp makes the signal real.
 */
export const ENGRAM_FETCH_LIMIT = 1000;

/** How long to wait for EOSE before giving up on the listing. */
const ENGRAM_QUERY_TIMEOUT_MS = 15_000;

export const agentMemoryQueryKey = (agentPubkey: string) =>
  ["agent-memory", agentPubkey.toLowerCase()] as const;

/**
 * One-shot REQ for an agent's engrams addressed to `ownerPubkey`, resolving
 * at EOSE. `RelaySession.subscribe` is a live subscription, so the handle is
 * released as soon as the stored set has arrived — this panel is a snapshot,
 * not a feed.
 *
 * The filter shape is the one the relay authorizes for an owner:
 * `engram_filters_authorized` (crates/buzz-relay/src/handlers/req.rs) accepts
 * an engram REQ when every `#p` value equals the authenticated reader, which
 * is exactly what this sends.
 */
export function queryEngramEvents(
  session: RelaySession,
  agentPubkey: string,
  ownerPubkey: string,
): Promise<SignedNostrEvent[]> {
  return new Promise((resolve) => {
    const events: SignedNostrEvent[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(events);
    };
    const timer = setTimeout(finish, ENGRAM_QUERY_TIMEOUT_MS);
    const unsubscribe = session.subscribe(
      {
        kinds: [ENGRAM_KIND],
        authors: [agentPubkey],
        "#p": [ownerPubkey],
        limit: ENGRAM_FETCH_LIMIT,
      },
      {
        onEvent: (event) => events.push(event),
        onEose: finish,
      },
    );
  });
}

/**
 * Fetch + decrypt one agent's engram listing.
 *
 * `enabled` is the caller's owner gate (see {@link useAgentMemory}); when
 * false no REQ is sent at all. Decryption needs the LOCAL unlocked key —
 * a NIP-07-only session cannot derive the conversation key, and the query
 * rejects with a message saying so rather than rendering an empty panel.
 *
 * `staleTime: 30s` matches the desktop: engrams change only when the agent
 * deliberately writes one, so re-opening the panel should be instant, while
 * a background write still surfaces within half a minute.
 */
export function useAgentMemoryQuery(
  agentPubkey: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const { session, status } = useRelaySession();
  const enabled =
    (options?.enabled ?? true) && !!agentPubkey && status === "open";

  return useQuery<AgentMemoryListing>({
    enabled,
    queryKey: agentMemoryQueryKey(agentPubkey ?? ""),
    staleTime: 30_000,
    queryFn: async () => {
      const secretKey = getUnlockedSecretKey();
      if (!secretKey) {
        throw new Error(
          "Reading agent memory needs the unlocked local key — this session signs with a browser extension, which cannot derive the NIP-44 conversation key.",
        );
      }
      const ownerPubkey = getPublicKey(secretKey);
      const events = await queryEngramEvents(
        session,
        agentPubkey as string,
        ownerPubkey,
      );
      return decodeEngramListing({
        events,
        agentPubkey: agentPubkey as string,
        ownerPubkey,
        ownerSecretKey: secretKey,
        // `>=` accepts a false positive at exactly the cap: a relay that
        // returned the clamp cannot be distinguished from one that happened
        // to hold exactly that many. The banner says "may be incomplete",
        // which covers the off-by-one.
        truncated: events.length >= ENGRAM_FETCH_LIMIT,
      });
    },
  });
}

/**
 * The viewer-facing hook: listing plus the memoized reachability graph.
 *
 * Mirrors the desktop's `useAgentMemoryGraph`. The graph is a pure function
 * of the listing, so it is recomputed only when the payload identity changes.
 */
export function useAgentMemory(
  agentPubkey: string | null | undefined,
  options?: { enabled?: boolean },
): {
  query: ReturnType<typeof useAgentMemoryQuery>;
  graph: MemoryGraph | null;
} {
  const query = useAgentMemoryQuery(agentPubkey, options);
  const graph = useMemo<MemoryGraph | null>(
    () => (query.data ? buildMemoryGraph(query.data) : null),
    [query.data],
  );
  return { query, graph };
}
