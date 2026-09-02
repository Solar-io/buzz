import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { buildOtherParticipants, parsePubkeyInput } from "../lib/dmInput.ts";
import { buildDmSuggestions, recipientLabel } from "../lib/dmPicker.ts";
import { openDm } from "../hooks";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useProfiles } from "@/features/channels/hooks";

/**
 * Start a DM: kind 41010 with p tags per participant (buzz-sdk
 * build_dm_open shape). The relay derives the channel id and returns it in
 * the OK message; the 39000 metadata then lands it in the DM list.
 *
 * Recipients are picked from a suggestion list (registered agents first,
 * then existing-DM counterparties) or pasted as npub/hex for keys the app
 * has not seen.
 */
export function NewDmDialog({
  onOpened,
  open: openProp,
  onOpenChange,
  contacts = [],
}: {
  onOpened: (channelId: string) => void;
  /** Controlled mode (sidebar + button) — renders no trigger of its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Counterparty pubkeys from the user's existing DMs (self may be included; it is filtered). */
  contacts?: string[];
}) {
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp ?? openInternal;
  const setOpen = (next: boolean) => {
    setOpenInternal(next);
    onOpenChange?.(next);
  };
  const [entry, setEntry] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { session } = useRelaySession();
  const [pubkey, setPubkey] = useState<string | null>(null);
  useEffect(() => {
    void ownPubkey().then(setPubkey);
  }, []);
  const agents = useAgentRegistry();

  const candidatePubkeys = useMemo(
    () => Array.from(new Set([...agents.map((a) => a.pubkey), ...contacts])),
    [agents, contacts],
  );
  const profiles = useProfiles(candidatePubkeys);

  const suggestions = useMemo(
    () =>
      buildDmSuggestions({
        agents,
        contacts,
        profiles,
        selfPubkey: pubkey,
        filter: "",
      }),
    [agents, contacts, profiles, pubkey],
  );
  const filtered = useMemo(
    () =>
      buildDmSuggestions({
        agents,
        contacts,
        profiles,
        selfPubkey: pubkey,
        filter: entry,
      }),
    [agents, contacts, profiles, pubkey, entry],
  );

  const addRecipient = (candidate: string) => {
    if (candidate === pubkey) {
      toast.error("That's your own key — a DM needs someone else.");
      return;
    }
    setRecipients((previous) =>
      previous.includes(candidate) ? previous : [...previous, candidate],
    );
    setEntry("");
  };

  const addFromEntry = () => {
    const parsed = parsePubkeyInput(entry);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    addRecipient(parsed.pubkey);
  };

  const start = async () => {
    if (busy) {
      return;
    }
    const validated = buildOtherParticipants(recipients, pubkey ?? "");
    if (!validated.ok) {
      toast.error(validated.error);
      return;
    }
    setBusy(true);
    try {
      const result = await openDm(session, validated.pubkeys);
      if (!result.ok) {
        toast.error(result.message || "The relay refused the DM.");
        return;
      }
      toast.success("DM opened");
      setOpen(false);
      setRecipients([]);
      if (result.channelId) {
        onOpened(result.channelId);
      }
      // No channelId in the response: the 39000 still lands the DM in the
      // sidebar — the user picks it from there.
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open the DM.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    if (openProp !== undefined) {
      return null;
    }
    return (
      <button
        type="button"
        className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
        onClick={() => setOpen(true)}
      >
        + New DM
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <p className="text-sm font-medium">New direct message</p>
      {recipients.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-testid="dm-recipients">
          {recipients.map((pk) => (
            <li
              key={pk}
              className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs"
              title={pk}
            >
              <span>{recipientLabel(pk, suggestions, profiles)}</span>
              <button
                type="button"
                aria-label="Remove recipient"
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
          placeholder="Pick below or paste npub… / 64-hex key"
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
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
      {filtered.length > 0 && (
        <ul
          className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background/60 p-1"
          data-testid="dm-suggestions"
        >
          {filtered.map((suggestion) => {
            const selected = recipients.includes(suggestion.pubkey);
            return (
              <li key={suggestion.pubkey}>
                <button
                  type="button"
                  disabled={selected}
                  aria-label={`Select ${suggestion.label}`}
                  data-testid={`dm-suggestion-${suggestion.pubkey}`}
                  title={suggestion.pubkey}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40"
                  onClick={() => addRecipient(suggestion.pubkey)}
                >
                  <span className="truncate">{suggestion.label}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {truncatePubkey(suggestion.pubkey)}
                    </span>
                    <span
                      className={
                        suggestion.sublabel === "Agent"
                          ? "rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground"
                          : "rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
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
      )}
      {suggestions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No known recipients yet — paste an npub or 64-hex public key above.
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || recipients.length === 0}
          onClick={() => void start()}
        >
          {busy ? "Opening…" : "Start"}
        </Button>
      </div>
    </div>
  );
}
