import { useState } from "react";
import type { AgentRegistryEntry } from "@/features/agents/lib/agentRegistry";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Button } from "@/shared/ui/button";

/** Existing agents only: creation and whole-team installation belong to P2/W11. */
export function AgentPickerSheet({
  agents,
  disabledReason,
  onAdd,
  onClose,
}: {
  agents: readonly AgentRegistryEntry[];
  disabledReason: (pubkey: string) => string | null;
  onAdd: (pubkey: string) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtered = agents.filter((agent) =>
    `${agent.name} ${agent.model}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle>Add an agent</DialogTitle>
        <DialogDescription>
          Agents already in this channel are hidden. Adding an agent starts it
          on Buzz Desktop.
        </DialogDescription>
        <Input
          aria-label="Find an agent"
          placeholder="Find an agent"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error && (
          <p role="alert" className="break-words text-sm text-coral-ink">
            {error}
          </p>
        )}
        <ul className="space-y-2">
          {filtered.map((agent) => {
            const reason = disabledReason(agent.pubkey);
            return (
              <li
                key={agent.pubkey}
                className="flex min-w-0 items-center gap-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{agent.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {reason ||
                      "Desktop reports this agent · Runtime status unavailable"}
                  </p>
                </div>
                <Button
                  className="min-h-11 shrink-0"
                  disabled={busy || !!reason}
                  aria-label={`Add ${agent.name}`}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await onAdd(agent.pubkey);
                      onClose();
                    } catch (issue) {
                      setError(
                        issue instanceof Error
                          ? issue.message
                          : "Could not add the agent.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Add
                </Button>
              </li>
            );
          })}
        </ul>
        {!filtered.length && (
          <p className="text-sm text-muted-foreground">
            No available agents match. All registered agents may already be
            here.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
