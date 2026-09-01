import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import {
  mergePersona,
  personaFromEvent,
  type PersonaDefinition,
} from "@/features/agents/lib/personas";

/**
 * The owner's kind-30175 persona definitions, live from the relay — the
 * definition quad for definition-linked agent instances. Replaceable events,
 * newest-wins per id (d tag = persona slug).
 */
export function usePersonas(): Map<string, PersonaDefinition> {
  const { session, status } = useRelaySession();
  const [personas, setPersonas] = useState<Map<string, PersonaDefinition>>(
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
        { kinds: [30175], authors: [pubkey], limit: 300 },
        {
          onEvent: (event) => {
            const persona = personaFromEvent(event);
            if (persona) {
              setPersonas((previous) => mergePersona(previous, persona));
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

  return personas;
}
