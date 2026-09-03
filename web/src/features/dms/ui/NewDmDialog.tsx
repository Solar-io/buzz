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
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";
import { findStaleAgents } from "@/features/agents/lib/staleAgents";
import { AgentWorkingDot } from "@/features/agents/ui/AgentsAdminPage";
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
  const [entryError, setEntryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A closed dialog is a CANCELLED dialog: clear the filter text and the
  // pending recipients so a reopen starts clean (QA: stale filter made the
  // reopened list look empty).
  useEffect(() => {
    if (!open) {
      setEntry("");
      setRecipients([]);
      setEntryError(null);
    }
  }, [open]);
  const { session } = useRelaySession();
  const [pubkey, setPubkey] = useState<string | null>(null);
  useEffect(() => {
    void ownPubkey().then(setPubkey);
  }, []);
  const agents = useAgentRegistry();
  const catalogs = useDesktopCatalogs();
  // Why a row is demoted, for the row's tooltip ("older duplicate of X" /
  // "not reported by any desktop"). Catalog-free until the desktop swap,
  // the duplicate-name half is deterministic and covers the re-mint pile.
  const staleReasons = useMemo(() => {
    const map = new Map<string, string>();
    for (const stale of findStaleAgents(agents, catalogs)) {
      map.set(stale.pubkey, stale.reason);
    }
    return map;
  }, [agents, catalogs]);

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
        stalePubkeys: new Set(staleReasons.keys()),
      }),
    [agents, contacts, profiles, pubkey, staleReasons],
  );
  const filtered = useMemo(
    () =>
      buildDmSuggestions({
        agents,
        contacts,
        profiles,
        selfPubkey: pubkey,
        filter: entry,
        stalePubkeys: new Set(staleReasons.keys()),
      }),
    [agents, contacts, profiles, pubkey, entry, staleReasons],
  );

  const addRecipient = (candidate: string) => {
    if (candidate === pubkey) {
      setEntryError("That's your own key — a DM needs someone else.");
      return;
    }
    setRecipients((previous) =>
      previous.includes(candidate) ? previous : [...previous, candidate],
    );
    setEntry("");
    setEntryError(null);
  };

  const addFromEntry = () => {
    const parsed = parsePubkeyInput(entry);
    if (!parsed.ok) {
      // Inline, next to the input: a corner toast is easy to miss while the
      // user's eyes are on the field (QA: invalid paste looked silent).
      setEntryError(parsed.error);
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
                  setRecipients((previous) => previous.filter((p) => p !== pk))
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
          data-testid="dm-input-error"
          role="alert"
        >
          {entryError}
        </p>
      )}
      {filtered.length > 0 && (
        <ul
          className="buzz-channel-activity-scrollbar max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background/60 p-1"
          data-testid="dm-suggestions"
        >
          {filtered.map((suggestion) => {
            const selected = recipients.includes(suggestion.pubkey);
            const staleReason = staleReasons.get(suggestion.pubkey);
            return (
              <li key={suggestion.pubkey}>
                <button
                  type="button"
                  disabled={selected}
                  aria-label={`Select ${suggestion.label}`}
                  data-testid={`dm-suggestion-${suggestion.pubkey}`}
                  title={
                    staleReason
                      ? `stale: ${staleReason} — ${suggestion.pubkey}`
                      : suggestion.pubkey
                  }
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40 ${
                    suggestion.stale ? "opacity-50" : ""
                  }`}
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
                        suggestion.stale
                          ? "rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300"
                          : suggestion.sublabel === "Agent"
                            ? "rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground"
                            : "rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                      }
                    >
                      {suggestion.stale ? "stale" : suggestion.sublabel}
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
