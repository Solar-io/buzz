import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import type { AgentRegistryEntry } from "@/features/agents/lib/agentRegistry";
import { applyRegistryEvent, type RegistryState } from "./lib/registryEvents";

/**
 * The owner's kind-30177 agent registry, live from the relay. Replaceable
 * events, newest-wins per agent pubkey.
 */
export function useAgentRegistry(): AgentRegistryEntry[] {
  const { session, status } = useRelaySession();
  const [state, setState] = useState<RegistryState>(() => ({
    registry: new Map(),
    tombstones: new Map(),
  }));

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
        [
          { kinds: [30177], authors: [pubkey], limit: 200 },
          { kinds: [5], authors: [pubkey], limit: 500 },
        ],
        {
          onEvent: (event) => {
            setState((previous) => applyRegistryEvent(previous, event, pubkey));
          },
        },
      );
    });
    return () => {
      alive = false;
      cleanup?.();
    };
  }, [session, status]);

  return Array.from(state.registry.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
