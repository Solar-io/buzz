import { useState } from "react";
import type { AgentRegistryEntry } from "@/features/agents/lib/agentRegistry";
import type { ChannelMember, Profile } from "../../hooks";
import { authorLabel } from "../../lib/authorLabel";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";

/** W3's channel entry point edits only the access fields already supported by Desktop. */
export function AgentInstructionDialog({
  agent,
  people,
  profiles,
  locked,
  onSave,
  onClose,
}: {
  agent: AgentRegistryEntry;
  people: ChannelMember[];
  profiles: Map<string, Profile>;
  locked: boolean;
  onSave: (
    mode: "owner-only" | "anyone" | "allowlist",
    people: string[],
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(agent.respondTo);
  const [allowlist, setAllowlist] = useState(agent.respondToAllowlist);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = [
    ...new Set([...people.map((person) => person.pubkey), ...allowlist]),
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle>Who can instruct {agent.name}</DialogTitle>
        <DialogDescription>
          This applies wherever the agent participates. Takes effect on restart.
        </DialogDescription>
        <label className="space-y-2 text-sm">
          Who can instruct
          <select
            className="min-h-11 w-full rounded-lg border border-border bg-card px-2"
            value={mode}
            disabled={busy || locked}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="owner-only">Only me</option>
            <option value="allowlist">Specific people</option>
            <option value="anyone">Anyone in the channel</option>
          </select>
        </label>
        {mode === "allowlist" && (
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Specific people</legend>
            {candidates.map((pubkey) => (
              <label
                key={pubkey}
                className="flex min-h-11 items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  disabled={busy || locked}
                  checked={allowlist.includes(pubkey)}
                  onChange={(event) =>
                    setAllowlist((previous) =>
                      event.target.checked
                        ? [...previous, pubkey]
                        : previous.filter((key) => key !== pubkey),
                    )
                  }
                />
                {authorLabel(pubkey, profiles)}
              </label>
            ))}
          </fieldset>
        )}
        {mode !== "owner-only" && (
          <p className="text-sm text-honey-ink">
            These people can ask the agent to use its tools and access its
            workspace.
          </p>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-coral-ink">
            {error}
          </p>
        )}
        <Button
          className="min-h-11"
          disabled={
            busy ||
            locked ||
            !["owner-only", "anyone", "allowlist"].includes(mode) ||
            (mode === "allowlist" && !allowlist.length)
          }
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave(
                mode as "owner-only" | "anyone" | "allowlist",
                allowlist,
              );
              onClose();
            } catch (issue) {
              setError(
                issue instanceof Error
                  ? issue.message
                  : "Could not change who can instruct.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Waiting for Desktop…" : "Save"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
