import { useMemo, useState } from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { Button } from "@/shared/ui/button";

import { useAgentVoiceSelections, useBridgeVoices } from "../hooks.ts";
import { publishAgentVoiceSelection } from "../lib/agentVoiceApi.ts";
import type {
  AgentVoiceSelection,
  AgentVoiceSelectionRow,
} from "../lib/agentVoiceSelection.ts";
import { isOutsideLibrary } from "../lib/voiceLibraryModel.ts";
import { VoicePickerDialog } from "./VoicePickerDialog.tsx";

function describeSelection(selection: AgentVoiceSelection | undefined): string {
  if (selection === undefined) {
    return "Derived from your key — a stable Chatterbox voice.";
  }
  if (selection.engine === "pocket") {
    return `Pocket voice ${selection.key} (spoken by its Chatterbox twin)`;
  }
  if (selection.engine === "chatterbox") {
    return `Chatterbox voice ${selection.key}`;
  }
  if (selection.engine === "fish") {
    return `Fish Audio voice ${selection.key}`;
  }
  if (selection.engine === "eleven") {
    return `ElevenLabs voice ${selection.key}`;
  }
  // A published on-device row from before the engine was dropped. It still
  // decodes, but it no longer decides: `resolveHuddleVoice` treats it as no
  // selection at all, so the derived Chatterbox default is what actually speaks
  // (huddle/lib/huddlePrefs.ts). Say so rather than naming a voice nobody
  // will hear.
  return `On-device voice ${selection.voiceURI} — no longer supported; the derived Chatterbox voice speaks instead.`;
}

/**
 * "Your voice" — the settings surface for the SIGNED-IN IDENTITY's own
 * speaking voice (kind 30182, author = you).
 *
 * Formerly titled "Agent voice", which read as "set my agent's voice" and
 * made Sam publish a 30182 for his own key on 2026-09-18. Retitled per the
 * 9/18 commitment; per-agent voices live in the "Agent voices" card, which
 * publishes the owner-signed kind 30183 instead.
 *
 * Lives in Settings rather than the huddle bar because the selection is a
 * property of the AGENT, not of one call: the same voice speaks in every
 * channel and DM, so a per-huddle affordance would imply huddle scoping the
 * store does not have. Same convention as presence: a card, a status line,
 * and a picker dialog.
 */
export function VoiceSettingsCard({
  selfPubkey,
}: {
  /** The logged-in identity — whose voice this card edits. */
  selfPubkey: string | null;
}) {
  const { session } = useRelaySession();
  const { byPubkey, agentVoiceSelectionFor } = useAgentVoiceSelections();
  const eleven = useBridgeVoices("eleven");
  const fish = useBridgeVoices("fish");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useMemo<AgentVoiceSelection | undefined>(
    () => (selfPubkey ? agentVoiceSelectionFor(selfPubkey) : undefined),
    [selfPubkey, agentVoiceSelectionFor],
  );
  const currentRow: AgentVoiceSelectionRow | undefined = useMemo(
    () => (selfPubkey ? byPubkey.get(selfPubkey.toLowerCase()) : undefined),
    [selfPubkey, byPubkey],
  );

  const library = current?.engine === "fish" ? fish : eleven;
  const missing =
    library.ready &&
    !library.error &&
    isOutsideLibrary(current, library.voices);

  async function confirm(
    selection: AgentVoiceSelection,
    label: string,
  ): Promise<void> {
    if (!selfPubkey) {
      throw new Error("No signed-in identity to publish a voice for.");
    }
    try {
      await publishAgentVoiceSelection(session, selection, label);
      setError(null);
    } catch (cause: unknown) {
      const message =
        cause instanceof Error ? cause.message : "Could not save the voice.";
      setError(message);
      throw cause;
    }
  }

  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-card p-4"
      data-testid="settings-agent-voice"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">Your voice</h2>
        <Button
          data-testid="agent-voice-choose"
          onClick={() => setPickerOpen(true)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Choose voice…
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Binds your own identity (used when agents read your messages aloud). To
        change an agent's voice, use Agent voices below.
      </p>
      <p className="text-sm text-muted-foreground">
        {describeSelection(current)}
        {currentRow !== undefined ? ` — set as “${currentRow.label}”.` : ""}
        {missing && (
          <span
            className="ml-2 rounded-full border border-border px-1.5 text-2xs"
            data-testid="voice-not-in-library"
          >
            not in library
          </span>
        )}
      </p>
      {error !== null && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <VoicePickerDialog
        current={current}
        currentLabel={currentRow?.label}
        onConfirm={confirm}
        onOpenChange={setPickerOpen}
        open={pickerOpen}
      />
    </section>
  );
}
