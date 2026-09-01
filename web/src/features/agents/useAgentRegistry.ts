import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import {
  agentFromEvent,
  mergeAgentEntry,
  type AgentRegistryEntry,
} from "@/features/agents/lib/agentRegistry";

/**
 * The owner's kind-30177 agent registry, live from the relay. Replaceable
 * events, newest-wins per agent pubkey.
 */
export function useAgentRegistry(): AgentRegistryEntry[] {
  const { session, status } = useRelaySession();
  const [registry, setRegistry] = useState<Map<string, AgentRegistryEntry>>(
    () => new Map(),
  );

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
        { kinds: [30177], authors: [pubkey], limit: 200 },
        {
          onEvent: (event) => {
            const entry = agentFromEvent(event);
            if (entry) {
              setRegistry((previous) => mergeAgentEntry(previous, entry));
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

  return Array.from(registry.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
