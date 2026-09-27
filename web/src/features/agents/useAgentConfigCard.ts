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
  type AgentVoiceSelection,
} from "@/features/voice/lib/agentVoiceSelection";
import {
  KIND_AGENT_VOICE_ASSIGNMENT,
  parseAgentVoiceAssignmentEvent,
} from "@/features/voice/lib/agentVoiceAssignment";
import {
  summarizeAgentVoice,
  type VoiceLayerRow,
} from "@/features/voice/lib/agentVoiceSummary";

export interface AgentConfigCardState {
  rows: AgentConfigRow[];
  loading: boolean;
  /**
   * The viewer owns this agent: their own 30177 names it. Gates the profile
   * card's "Change voice…" (the relay would refuse a non-owner's 30183
   * anyway; this keeps the button from being offered at all).
   */
  viewerIsOwner: boolean;
  /** The agent's display name from the owner's 30177, when known. */
  agentName: string | null;
  /** The owner's current 30183 selection for this agent, if any. */
  assignedVoice: AgentVoiceSelection | undefined;
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
 * - the owner's 30183 voice assignment for it (`#d` = agent pubkey)
 *
 * The Voice row is the EFFECTIVE voice under the shared precedence
 * (owner assignment > agent's choice > derived), with its source:
 * `Evie (Chatterbox) · set by owner`.
 */
export function useAgentConfigCard(pubkey: string): AgentConfigCardState {
  const { session, status } = useRelaySession();
  const [entry, setEntry] = useState<AgentRegistryEntry | null>(null);
  const [entryDone, setEntryDone] = useState(false);
  const [persona, setPersona] = useState<PersonaDefinition | null>(null);
  const [selfVoice, setSelfVoice] = useState<VoiceLayerRow | undefined>();
  const [assigned, setAssigned] = useState<
    (VoiceLayerRow & { createdAt: number }) | undefined
  >();
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
            setSelfVoice({ selection: row.selection, label: row.label });
          }
        },
      },
    );
  }, [session, status, pubkey]);

  useEffect(() => {
    if (!session || status !== "open") {
      return;
    }
    return session.subscribe(
      {
        kinds: [KIND_AGENT_VOICE_ASSIGNMENT],
        "#d": [pubkey.toLowerCase()],
        limit: 1,
      },
      {
        onEvent: (event) => {
          const row = parseAgentVoiceAssignmentEvent(event);
          if (row && row.agentPubkey === pubkey.toLowerCase()) {
            setAssigned((prev) =>
              prev && prev.createdAt >= row.createdAt
                ? prev
                : {
                    selection: row.selection,
                    label: row.label,
                    createdAt: row.createdAt,
                  },
            );
          }
        },
      },
    );
  }, [session, status, pubkey]);

  const viewerIsOwner = entry !== null;
  const voice = useMemo(() => {
    const summary = summarizeAgentVoice({
      agentPubkey: pubkey,
      assignment: assigned,
      self: selfVoice,
      // No roster fetch per hover: published rows carry their own label and
      // the derived slugs capitalize to their roster names.
      roster: [],
      // AC-W5 copy: the card says "set by owner" whoever is looking.
      viewerIsOwner: false,
    });
    return `${summary.voice} · ${summary.sourceLabel}`;
  }, [pubkey, assigned, selfVoice]);

  const rows = useMemo(
    () =>
      agentConfigRows({
        entry,
        persona: entry?.personaId ? persona : null,
        voice,
      }),
    [entry, persona, voice],
  );
  return {
    rows,
    loading: !entryDone && entry === null,
    viewerIsOwner,
    agentName: entry?.name ?? null,
    assignedVoice: assigned?.selection,
  };
}
