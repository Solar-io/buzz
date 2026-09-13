import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { parsePubkeyInput } from "@/features/dms/lib/dmInput.ts";
import {
  buildDmSuggestions,
  recipientLabel,
  resolveSuggestionQuery,
} from "@/features/dms/lib/dmPicker.ts";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { AgentWorkingDot } from "@/features/agents/ui/AgentsAdminPage";
import { useProfiles } from "../hooks.ts";
import {
  excludeCurrentMembers,
  memberAddRoleFor,
  publishChannelMemberAdds,
} from "../lib/addChannelMembers.ts";

/**
 * Add members to a channel, from the roster popover.
 *
 * Modelled on the New-DM dialog: chips, a filter-as-you-type suggestion list
 * (registered agents + DM contacts, MINUS this channel's current roster), and
 * the same typed-name resolution so "gilfoyle" + Enter adds Gilfoyle instead
 * of demanding a key. Paste still works for keys the app has never seen.
 *
 * The affordance renders for everyone and the RELAY is the rights gate — a
 * member without rights publishes, gets refused, and the refusal text lands
 * in a toast (the huddle add-agent precedent). The add itself mirrors the
 * desktop exactly: one kind-9000 event per member, agents as `bot`, humans
 * role-less; see `lib/addChannelMembers.ts` for the parity notes. After a
 * success the roster needs no refetch — the relay republishes the channel's
 * kind-39002 members event and the header's live subscription picks it up.
 */
export function AddChannelMembersDialog({
  open,
  onOpenChange,
  channelId,
  memberPubkeys,
  contacts = [],
  selfPubkey = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel to add into (kind-9000 `h` tag). */
  channelId: string;
  /** The channel's current roster — excluded from the suggestions. */
  memberPubkeys: readonly string[];
  /** Counterparty pubkeys from the user's existing DMs (same source the New-DM dialog uses). */
  contacts?: string[];
  /** The viewer — never suggested. */
  selfPubkey?: string | null;
}) {
  const { session } = useRelaySession();
  const agents = useAgentRegistry();
  const [entry, setEntry] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Row clicks land focus on the clicked button; handing it back to the
  // entry lets the next name be typed without a mouse round-trip.
  const entryRef = useRef<HTMLInputElement>(null);
  // A closed dialog is a CANCELLED dialog: reopen starts clean.
  useEffect(() => {
    if (!open) {
      setEntry("");
      setRecipients([]);
      setEntryError(null);
    }
  }, [open]);

  const { agents: eligibleAgents, contacts: eligibleContacts } = useMemo(
    () => excludeCurrentMembers({ agents, contacts, memberPubkeys }),
    [agents, contacts, memberPubkeys],
  );
  const candidatePubkeys = useMemo(
    () => [
      ...new Set([...eligibleAgents.map((a) => a.pubkey), ...eligibleContacts]),
    ],
    [eligibleAgents, eligibleContacts],
  );
  const profiles = useProfiles(candidatePubkeys);

  const suggestions = useMemo(
    () =>
      buildDmSuggestions({
        agents: eligibleAgents,
        contacts: eligibleContacts,
        profiles,
        selfPubkey,
        filter: "",
      }),
    [eligibleAgents, eligibleContacts, profiles, selfPubkey],
  );
  const filtered = useMemo(
    () =>
      buildDmSuggestions({
        agents: eligibleAgents,
        contacts: eligibleContacts,
        profiles,
        selfPubkey,
        filter: entry,
      }),
    [eligibleAgents, eligibleContacts, profiles, selfPubkey, entry],
  );

  const addRecipient = (candidate: string) => {
    if (
      memberPubkeys.some((pk) => pk.toLowerCase() === candidate.toLowerCase())
    ) {
      setEntryError("They are already in this channel.");
      return;
    }
    setRecipients((previous) =>
      previous.includes(candidate) ? previous : [...previous, candidate],
    );
    setEntry("");
    setEntryError(null);
    entryRef.current?.focus();
  };

  const addFromEntry = () => {
    const text = entry.trim();
    if (text.length === 0) {
      return;
    }
    const parsed = parsePubkeyInput(text);
    if (!parsed.ok) {
      // Same contract as the New-DM dialog: wrong-kind keys surface the
      // parser's specific error; other non-key text gets resolved against
      // the filtered suggestions before an actionable error.
      if (parsed.reason === "wrong-type") {
        setEntryError(parsed.error);
        return;
      }
      const resolved = resolveSuggestionQuery(text, filtered);
      if (resolved) {
        addRecipient(resolved.pubkey);
        return;
      }
      setEntryError(
        `No one here matches "${text}" — pick someone from the list below, or paste an npub / 64-hex key.`,
      );
      return;
    }
    addRecipient(parsed.pubkey);
  };

  const submit = async () => {
    if (busy || recipients.length === 0) {
      return;
    }
    setBusy(true);
    try {
      // One event per member, agents as `bot` — desktop parity, and the loop
      // collects per-member refusals instead of stopping at the first.
      const outcome = await publishChannelMemberAdds({
        channelId,
        members: recipients.map((pubkey) => ({
          pubkey,
          role: memberAddRoleFor(pubkey, agents),
        })),
        send: async (event) => session.publish(await signNostrEvent(event)),
      });
      for (const failure of outcome.failures) {
        const name = recipientLabel(failure.pubkey, suggestions, profiles);
        toast.error(`${name}: ${failure.message}`);
      }
      if (outcome.added.length > 0) {
        toast.success(
          outcome.added.length === 1
            ? "Member added"
            : `${outcome.added.length} members added`,
        );
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not add members.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-md space-y-2"
        data-testid="add-channel-members-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add members</DialogTitle>
          <DialogDescription>
            Pick from your agents and DM contacts, or paste an npub / 64-hex
            key. The relay decides who may add.
          </DialogDescription>
        </DialogHeader>
        {recipients.length > 0 && (
          <ul
            className="flex flex-wrap gap-1"
            data-testid="channel-member-chips"
          >
            {recipients.map((pk) => (
              <li
                key={pk}
                className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs"
                title={pk}
              >
                <span>{recipientLabel(pk, suggestions, profiles)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${recipientLabel(pk, suggestions, profiles)}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setRecipients((previous) =>
                      previous.filter((p) => p !== pk),
                    )
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <Input
            ref={entryRef}
            aria-label="Add member by name or public key"
            data-testid="add-channel-members-input"
            placeholder="Pick below or paste npub… / 64-hex key"
            value={entry}
            onChange={(event) => {
              setEntry(event.target.value);
              setEntryError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addFromEntry();
              }
            }}
            autoFocus
          />
          <Button variant="secondary" size="sm" onClick={addFromEntry}>
            Add
          </Button>
        </div>
        {entryError && (
          <p
            className="text-xs text-red-400"
            data-testid="add-channel-members-error"
            role="alert"
          >
            {entryError}
          </p>
        )}
        {filtered.length > 0 ? (
          <ul
            className="buzz-channel-activity-scrollbar max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background/60 p-1"
            data-testid="add-channel-members-suggestions"
          >
            {filtered.map((suggestion) => {
              const selected = recipients.includes(suggestion.pubkey);
              return (
                <li key={suggestion.pubkey}>
                  <button
                    type="button"
                    disabled={selected}
                    aria-label={`Select ${suggestion.label}`}
                    data-testid={`add-channel-members-suggestion-${suggestion.pubkey}`}
                    title={suggestion.pubkey}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40"
                    onClick={() => addRecipient(suggestion.pubkey)}
                  >
                    <span className="flex shrink-0 items-center gap-1.5">
                      {suggestion.sublabel === "Agent" && (
                        <AgentWorkingDot pubkey={suggestion.pubkey} />
                      )}
                      <span className="truncate">{suggestion.label}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {truncatePubkey(suggestion.pubkey)}
                      </span>
                      <span
                        className={
                          suggestion.sublabel === "Agent"
                            ? "rounded bg-accent px-1.5 py-0.5 text-badge uppercase tracking-wide text-foreground"
                            : "rounded bg-muted px-1.5 py-0.5 text-badge uppercase tracking-wide text-muted-foreground"
                        }
                      >
                        {suggestion.sublabel}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Everyone you know is already in this channel — paste an npub /
            64-hex key above to add a stranger.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="add-channel-members-submit"
            disabled={busy || recipients.length === 0}
            size="sm"
            onClick={() => void submit()}
          >
            {busy
              ? "Adding…"
              : recipients.length > 1
                ? `Add ${recipients.length} members`
                : "Add member"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
