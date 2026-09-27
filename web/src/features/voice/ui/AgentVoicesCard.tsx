import { useEffect, useState } from "react";

import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import { Button } from "@/shared/ui/button";

import {
  useAgentVoiceAssignments,
  useAgentVoiceSelections,
  useChatterboxVoices,
} from "../hooks.ts";
import {
  clearAgentVoiceAssignment,
  publishAgentVoiceAssignment,
} from "../lib/agentVoiceApi.ts";
import type { AgentVoiceSelection } from "../lib/agentVoiceSelection.ts";
import {
  previewRequestFor,
  summarizeAgentVoice,
} from "../lib/agentVoiceSummary.ts";
import { VoicePickerDialog } from "./VoicePickerDialog.tsx";
import { createVoicePreviewer } from "./voicePreview.ts";

/**
 * "Agent voices" — where the signed-in OWNER sets each of their agents'
 * voices (design §5.2). Lists the owner's kind-30177 registry; each row
 * shows the effective voice and who decided it.
 *
 * Change… publishes the owner-signed kind 30183 (`d` = agent) through
 * `publishAgentVoiceAssignment` and NEVER the 30182 publisher — signing a
 * 30182 here would bind the owner's own voice, the 9/18 trap. Reset
 * deletes the 30183 by coordinate so the agent's own choice (or the
 * derived default) speaks again. Hidden for identities with no agents.
 */
export function AgentVoicesCard() {
  const { session } = useRelaySession();
  const owner = useOwnPubkey();
  const agents = useAgentRegistry();
  const { byAgent, ingest } = useAgentVoiceAssignments();
  const { byPubkey } = useAgentVoiceSelections();
  const { voices: roster } = useChatterboxVoices();
  const [editing, setEditing] = useState<{
    pubkey: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewer] = useState(() => createVoicePreviewer());
  useEffect(() => () => previewer.dispose(), [previewer]);

  if (agents.length === 0) {
    return null;
  }

  const editingCurrent: AgentVoiceSelection | undefined = editing
    ? byAgent.get(editing.pubkey.toLowerCase())?.selection
    : undefined;

  async function assign(
    agentPubkey: string,
    selection: AgentVoiceSelection,
    label: string,
  ): Promise<void> {
    try {
      await publishAgentVoiceAssignment(session, agentPubkey, selection, label);
      setError(null);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the voice.",
      );
      throw cause;
    }
  }

  async function reset(agentPubkey: string): Promise<void> {
    if (!owner) {
      return;
    }
    try {
      const deletion = await clearAgentVoiceAssignment(
        session,
        owner,
        agentPubkey,
      );
      ingest(deletion);
      setError(null);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not reset the voice.",
      );
    }
  }

  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-card p-4"
      data-testid="settings-agent-voices"
    >
      <h2 className="font-medium">Agent voices</h2>
      <p className="text-xs text-muted-foreground">
        The voice each of your agents speaks with, for every listener. Your
        choice outranks the agent's own.
      </p>
      {error !== null && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {agents.map((agent) => {
          const key = agent.pubkey.toLowerCase();
          const assignment = byAgent.get(key);
          const self = byPubkey.get(key);
          const summary = summarizeAgentVoice({
            agentPubkey: agent.pubkey,
            assignment,
            self,
            roster,
            viewerIsOwner: true,
          });
          return (
            <li
              className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
              data-testid="agent-voices-row"
              key={agent.pubkey}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {agent.name}
                </span>
                <span
                  className="block truncate text-xs text-muted-foreground"
                  data-testid="agent-voices-value"
                >
                  {summary.voice}
                  <span
                    className="ml-2 rounded-full border border-border px-1.5 text-2xs"
                    data-testid="agent-voices-source"
                  >
                    {summary.sourceLabel}
                  </span>
                </span>
              </span>
              <Button
                data-testid="agent-voices-preview"
                onClick={() =>
                  previewer.preview(
                    previewRequestFor(agent.pubkey, summary.selection),
                  )
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Preview
              </Button>
              <Button
                data-testid="agent-voices-change"
                onClick={() =>
                  setEditing({ pubkey: agent.pubkey, name: agent.name })
                }
                size="sm"
                type="button"
                variant="secondary"
              >
                Change…
              </Button>
              {assignment !== undefined && (
                <Button
                  data-testid="agent-voices-reset"
                  onClick={() => void reset(agent.pubkey)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Reset
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <VoicePickerDialog
        current={editingCurrent}
        mode="assign"
        onConfirm={(selection, label) =>
          editing ? assign(editing.pubkey, selection, label) : Promise.resolve()
        }
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        open={editing !== null}
        target={editing}
      />
    </section>
  );
}
