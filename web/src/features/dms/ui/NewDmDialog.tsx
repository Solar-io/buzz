import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { buildOtherParticipants, parsePubkeyInput } from "../lib/dmInput.ts";
import { openDm } from "../hooks";

/**
 * Start a DM: kind 41010 with p tags per participant (buzz-sdk
 * build_dm_open shape). The relay derives the channel id and returns it in
 * the OK message; the 39000 metadata then lands it in the DM list.
 */
export function NewDmDialog({
  onOpened,
}: {
  onOpened: (channelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { session } = useRelaySession();
  const [pubkey, setPubkey] = useState<string | null>(null);
  useEffect(() => {
    void ownPubkey().then(setPubkey);
  }, []);

  const addRecipient = () => {
    const parsed = parsePubkeyInput(entry);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setRecipients((previous) =>
      previous.includes(parsed.pubkey) || parsed.pubkey === pubkey
        ? previous
        : [...previous, parsed.pubkey],
    );
    setEntry("");
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
          {recipients.map((pubkey) => (
            <li
              key={pubkey}
              className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs"
            >
              <span className="font-mono">{truncatePubkey(pubkey)}</span>
              <button
                type="button"
                aria-label="Remove recipient"
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setRecipients((previous) =>
                    previous.filter((p) => p !== pubkey),
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
          placeholder="npub… or 64-hex public key"
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addRecipient();
            }
          }}
          autoFocus
        />
        <Button variant="secondary" size="sm" onClick={addRecipient}>
          Add
        </Button>
      </div>
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
