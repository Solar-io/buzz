import { useEffect, useMemo, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import {
  agentFromEvent,
  type AgentRegistryEntry,
} from "@/features/agents/lib/agentRegistry";
import {
  personaFromEvent,
  type PersonaDefinition,
} from "@/features/agents/lib/personas";
import {
  agentConfigRows,
  type AgentConfigRow,
} from "@/features/agents/lib/agentConfigCard";
import {
  AGENT_VOICE_D_TAG,
  KIND_AGENT_VOICE,
  parseAgentVoiceEvent,
} from "@/features/voice/lib/agentVoiceSelection";

export interface AgentConfigCardState {
  rows: AgentConfigRow[];
  loading: boolean;
}

/**
 * Per-open fetch for the agent config card. Mount it ONLY while the card is
 * armed or open — it opens up to three narrow subscriptions (each with
 * explicit `kinds`), so mounting it per rendered row would cost three REQs per
 * message:
 *
 * - the owner's 30177 for this agent (`#d` = agent pubkey)
 * - once that resolves and is definition-linked, the owner's 30175 definition
 * - the agent's own 30182 voice selection (`#d` = `agent-voice`)
 */
export function useAgentConfigCard(pubkey: string): AgentConfigCardState {
  const { session, status } = useRelaySession();
  const [entry, setEntry] = useState<AgentRegistryEntry | null>(null);
  const [entryDone, setEntryDone] = useState(false);
  const [persona, setPersona] = useState<PersonaDefinition | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  // Re-resolving hook (see its docblock): a one-shot ownPubkey() at mount
  // can resolve null before the key store loads and never ask again.
  const owner = useOwnPubkey();

  useEffect(() => {
    if (!session || status !== "open" || !owner) {
      return;
    }
    return session.subscribe(
      { kinds: [30177], authors: [owner], "#d": [pubkey], limit: 1 },
      {
        onEvent: (event) => {
          const next = agentFromEvent(event);
          if (next && next.pubkey === pubkey) {
            setEntry((prev) =>
              prev && prev.updatedAt >= next.updatedAt ? prev : next,
            );
          }
        },
        onEose: () => setEntryDone(true),
      },
    );
  }, [session, status, owner, pubkey]);

  const personaId = entry?.personaId ?? null;
  useEffect(() => {
    if (!session || status !== "open" || !owner || !personaId) {
      return;
    }
    return session.subscribe(
      { kinds: [30175], authors: [owner], "#d": [personaId], limit: 1 },
      {
        onEvent: (event) => {
          const next = personaFromEvent(event);
          if (next && next.id === personaId) {
            setPersona((prev) =>
              prev && prev.updatedAt >= next.updatedAt ? prev : next,
            );
          }
        },
      },
    );
  }, [session, status, owner, personaId]);

  useEffect(() => {
    if (!session || status !== "open") {
      return;
    }
    return session.subscribe(
      {
        kinds: [KIND_AGENT_VOICE],
        authors: [pubkey],
        "#d": [AGENT_VOICE_D_TAG],
        limit: 1,
      },
      {
        onEvent: (event) => {
          const row = parseAgentVoiceEvent(event);
          if (row && row.pubkey === pubkey) {
            setVoice(row.label);
          }
        },
      },
    );
  }, [session, status, pubkey]);

  const rows = useMemo(
    () =>
      agentConfigRows({
        entry,
        persona: entry?.personaId ? persona : null,
        voice,
      }),
    [entry, persona, voice],
  );
  return { rows, loading: !entryDone && entry === null };
}
