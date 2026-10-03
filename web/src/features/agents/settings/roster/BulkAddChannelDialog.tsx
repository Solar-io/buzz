import { useState } from "react";
import { useChannels } from "@/features/channels/useChannels";
import { publishChannelMemberAdds } from "@/features/channels/lib/addChannelMembers";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import type { RelaySession } from "@/shared/api/relay-session";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import type { RosterRow } from "../../lib/roster";

export function BulkAddChannelDialog({
  rows,
  session,
  onClose,
}: {
  rows: readonly RosterRow[];
  session: RelaySession;
  onClose: () => void;
}) {
  const { channels } = useChannels();
  const choices = channels.filter(
    (channel) => !channel.archived && channel.type !== "dm",
  );
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const add = async () => {
    if (busy || !choices.some((channel) => channel.id === channelId)) return;
    setBusy(true);
    try {
      const result = await publishChannelMemberAdds({
        channelId,
        members: rows.map((row) => ({ pubkey: row.pubkey, role: "bot" })),
        send: async (event) => session.publish(await signNostrEvent(event)),
      });
      setReceipt(
        `${result.added.length} added${result.failures
          .map(
            (failure) =>
              ` · ${rows.find((row) => row.pubkey === failure.pubkey)?.name}: ${failure.message}`,
          )
          .join("")}`,
      );
    } catch (error) {
      setReceipt(
        error instanceof Error ? error.message : "Could not add agents.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Add {rows.length} agents to a channel</DialogTitle>
        <DialogDescription>
          Choose a channel you can manage. Each addition applies immediately.
        </DialogDescription>
        <select
          aria-label="Add selected agents to channel"
          value={channelId}
          disabled={busy}
          onChange={(event) => {
            setChannelId(event.target.value);
            setReceipt("");
          }}
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          <option value="">Choose a channel</option>
          {choices.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
        <Button
          className="h-11"
          disabled={busy || !channelId}
          onClick={() => void add()}
        >
          {busy ? "Adding…" : "Add agents"}
        </Button>
        {receipt ? (
          <p role="status" className="break-words text-sm">
            {receipt}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
