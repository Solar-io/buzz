import { Bot, SmilePlus, Volume2, VolumeX } from "lucide-react";
import { useState } from "react";
import { EmojiPicker } from "@/features/custom-emoji/ui/EmojiPicker";
import { cn } from "@/shared/lib/cn";
import type { HuddleAgentSpeech } from "../useHuddleAgentSpeech";
import { AddHuddleAgentDialog } from "./AddHuddleAgentDialog";

/**
 * The in-call controls the desktop's huddle bar carries beyond mic and
 * leave: an emoji reaction, agent speech, and "add an agent".
 *
 * Split out of `HuddleBar` so that file stays a layout, and because these
 * three share nothing but a row.
 */
export function HuddleCallControls({
  onReact,
  speech,
  agentPubkeys,
  onAddAgent,
  reactionError,
}: {
  onReact: (emoji: string) => void;
  speech: HuddleAgentSpeech;
  agentPubkeys: readonly string[];
  onAddAgent: (input: {
    agentPubkey: string;
    agentName: string;
  }) => Promise<{ ok: boolean; message: string }>;
  reactionError: string | null;
}) {
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const speaking = speech.enabled && speech.supported;
  const suppressed = speech.suppressedAgents.length > 0;

  return (
    <div className="flex items-center gap-1.5">
      <EmojiPicker label="Send a reaction" onSelect={onReact}>
        {(props) => (
          <button
            {...props}
            data-testid="huddle-react"
            type="button"
            className="rounded-full border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
          >
            <SmilePlus aria-hidden className="h-3.5 w-3.5" />
          </button>
        )}
      </EmojiPicker>

      <button
        type="button"
        data-testid="huddle-agent-speech"
        aria-pressed={speaking}
        disabled={!speech.supported}
        onClick={() => speech.setEnabled(!speech.enabled)}
        title={
          !speech.supported
            ? "This browser has no speech synthesizer."
            : suppressed
              ? "Agent speech is on. Agents already broadcasting into the call are not re-spoken here."
              : "Read agent replies aloud in this browser only."
        }
        className={cn(
          "flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium disabled:opacity-50",
          speaking
            ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-400"
            : "border-border text-muted-foreground",
        )}
      >
        {speaking ? (
          <Volume2 aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <VolumeX aria-hidden className="h-3.5 w-3.5" />
        )}
        <span className="sr-only">
          {speaking ? "Stop reading agent replies" : "Read agent replies"}
        </span>
      </button>

      <button
        type="button"
        data-testid="huddle-add-agent"
        onClick={() => setAddAgentOpen(true)}
        title="Add an agent to this huddle"
        className="rounded-full border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
      >
        <Bot aria-hidden className="h-3.5 w-3.5" />
        <span className="sr-only">Add an agent</span>
      </button>

      {reactionError && (
        <span className="text-2xs text-red-400" role="alert">
          {reactionError}
        </span>
      )}

      <AddHuddleAgentDialog
        currentAgentPubkeys={agentPubkeys}
        onAdd={onAddAgent}
        onOpenChange={setAddAgentOpen}
        open={addAgentOpen}
      />
    </div>
  );
}
