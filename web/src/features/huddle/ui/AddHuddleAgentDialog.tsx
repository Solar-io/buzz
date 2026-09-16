import { useEffect, useMemo, useState } from "react";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  MAX_HUDDLE_AGENTS,
  selectableHuddleAgents,
} from "../lib/huddleAgents.ts";
import { rawHuddleAgentEntry } from "../lib/huddleRawEntry.ts";

/**
 * Pick an agent to add to this huddle.
 *
 * The desktop's dialog reads `list_managed_agents` over Tauri and can also
 * start a stopped agent before adding it. Neither is available in a browser,
 * so this differs in three stated ways rather than pretending parity:
 *
 *  - the list is the OWNER'S kind-30177 registry (the published projection of
 *    the same agents), not the desktop's local managed-agent store,
 *  - there is no start step and no running/stopped column, because no
 *    running-state signal exists on the wire. An agent whose process is down
 *    is added to the huddle and joins when it next runs; the membership event
 *    is what it subscribes on, and
 *  - the dialog offers raw-key entry (paste an npub / 64-hex key) beside the
 *    registry list, because a non-owner identity has no kind-30177 rows of
 *    its own — for them the list is empty and the registry alone is a dead
 *    end. The add itself is pubkey-based, so the key is all that is needed;
 *    see `lib/huddleRawEntry.ts` for the parse/duplicate half.
 *
 * The add itself is identical to the desktop's: kind-9000 add-member events,
 * role `bot`. See `lib/huddleAgents.ts`.
 */
export function AddHuddleAgentDialog({
  open,
  onOpenChange,
  currentAgentPubkeys,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bot members already in the huddle — excluded from the list. */
  currentAgentPubkeys: readonly string[];
  onAdd: (input: {
    agentPubkey: string;
    agentName: string;
  }) => Promise<{ ok: boolean; message: string }>;
}) {
  const registry = useAgentRegistry();
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entry, setEntry] = useState("");

  useEffect(() => {
    if (open) {
      setAdding(null);
      setError(null);
      setNotice(null);
      setEntry("");
    }
  }, [open]);

  const available = useMemo(
    () =>
      selectableHuddleAgents(
        registry.map((entry) => ({
          pubkey: entry.pubkey,
          name: entry.name,
        })),
        currentAgentPubkeys,
      ),
    [registry, currentAgentPubkeys],
  );

  const atCapacity = currentAgentPubkeys.length >= MAX_HUDDLE_AGENTS;

  async function add(agent: { pubkey: string; name: string }) {
    if (adding !== null) {
      return;
    }
    setAdding(agent.pubkey);
    setError(null);
    setNotice(null);
    try {
      const result = await onAdd({
        agentPubkey: agent.pubkey,
        agentName: agent.name,
      });
      if (result.ok) {
        // A partial success (huddle yes, parent channel no) keeps the dialog
        // open with its message, exactly as the desktop's does.
        if (result.message.includes("but the channel add failed")) {
          setNotice(result.message);
          setEntry("");
        } else {
          onOpenChange(false);
        }
      } else {
        setError(result.message);
      }
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not add the agent.",
      );
    } finally {
      setAdding(null);
    }
  }

  // The raw-key path: parse and duplicate-check BEFORE anything is published
  // (lib/huddleRawEntry.ts), so a bad paste costs a message, not a round-trip.
  // An empty field is a no-op rather than an error — Enter in a blank input
  // should not lecture. A relay-side refusal (duplicate racing in, capacity)
  // still surfaces through `add`'s `onAdd` error path; the text stays in the
  // field so it can be corrected or retried.
  function addFromEntry() {
    if (adding !== null || entry.trim().length === 0) {
      return;
    }
    const result = rawHuddleAgentEntry(entry, currentAgentPubkeys);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    void add({ pubkey: result.pubkey, name: result.name });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="add-huddle-agent-dialog">
        <DialogHeader>
          <DialogTitle>Add an agent</DialogTitle>
          <DialogDescription>
            Agents from your registry, or paste an npub / 64-hex key. Adding one
            publishes a huddle membership event; the agent joins when it sees
            it.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400"
            role="alert"
          >
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
            {notice}
          </p>
        )}

        {atCapacity ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            This huddle already has the maximum of {MAX_HUDDLE_AGENTS} agents.
          </p>
        ) : available.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {registry.length === 0
              ? "No agents in your registry yet — paste an npub / 64-hex key to add any agent."
              : "Every agent you have is already in this huddle — paste an npub / 64-hex key to add another."}
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {available.map((agent) => (
              <li key={agent.pubkey}>
                <Button
                  className="w-full justify-start gap-2"
                  data-testid="add-huddle-agent-row"
                  disabled={adding !== null}
                  onClick={() => void add(agent)}
                  type="button"
                  variant="ghost"
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {agent.name}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {adding === agent.pubkey
                      ? "Adding…"
                      : truncatePubkey(agent.pubkey)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/* Raw-key entry, offered ALWAYS — the registry list is owner-only
            state, so for any other member this field is the whole dialog. */}
        <div className="flex gap-2">
          <Input
            aria-label="Add an agent by public key"
            data-testid="add-huddle-agent-input"
            disabled={adding !== null}
            placeholder="Paste npub… / 64-hex key"
            value={entry}
            onChange={(event) => {
              setEntry(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addFromEntry();
              }
            }}
          />
          <Button
            data-testid="add-huddle-agent-add"
            disabled={adding !== null}
            onClick={addFromEntry}
            size="sm"
            type="button"
            variant="secondary"
          >
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
