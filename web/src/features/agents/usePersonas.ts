import { useCallback, useEffect, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import {
  mergePersona,
  personaFromEvent,
  type PersonaDefinition,
} from "@/features/agents/lib/personas";
import {
  admitAfterTombstone,
  applyTombstone,
  withoutKey,
} from "@/features/agents/lib/tombstones";

export interface PersonasState {
  map: Map<string, PersonaDefinition>;
  /**
   * Drop a definition the web just deleted and ignore any later-arriving
   * version at or before the tombstone. Desktop-originated deletes are NOT
   * observed live (no kind-5 subscription) — those still need a reload.
   */
  forget: (id: string, tombstoneCreatedAt: number) => void;
}

/**
 * The owner's kind-30175 persona definitions, live from the relay — the
 * definition quad for definition-linked agent instances. Replaceable events,
 * newest-wins per id (d tag = persona slug).
 */
export function usePersonas(): PersonasState {
  const { session, status } = useRelaySession();
  const [personas, setPersonas] = useState<Map<string, PersonaDefinition>>(
    () => new Map(),
  );
  const tombstones = useRef<Map<string, number>>(new Map());

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
            if (
              persona &&
              admitAfterTombstone(
                tombstones.current,
                persona.id,
                persona.updatedAt,
              )
            ) {
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

  const forget = useCallback((id: string, tombstoneCreatedAt: number) => {
    tombstones.current = applyTombstone(
      tombstones.current,
      id,
      tombstoneCreatedAt,
    );
    setPersonas((previous) => {
      const existing = previous.get(id);
      if (existing && existing.updatedAt > tombstoneCreatedAt) {
        return previous;
      }
      return withoutKey(previous, id);
    });
  }, []);

  return { map: personas, forget };
}
