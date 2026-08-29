import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Create a channel: kind 9007 with h/name/visibility/about tags (mirrors
 * buzz-sdk build_create_channel). The relay emits the 39000 metadata that
 * lands it in every channel list.
 */
export function NewChannelDialog({
  onCreated,
}: {
  onCreated: (channelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const { session } = useRelaySession();

  const create = async () => {
    // Match buzz-core canonical_channel_name: strip a leading #.
    const trimmed = name.trim().replace(/^#+/, "");
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    try {
      const channelId = crypto.randomUUID();
      const event = await signNostrEvent({
        kind: 9007,
        tags: [
          ["h", channelId],
          ["name", trimmed],
          ["visibility", isPrivate ? "private" : "open"],
          ...(about.trim() ? [["about", about.trim()]] : []),
        ],
        content: "",
      });
      const result = await session.publish(event);
      if (result.ok) {
        toast.success(`Channel #${trimmed} created`);
        setOpen(false);
        setName("");
        setAbout("");
        onCreated(channelId);
      } else {
        toast.error(result.message || "The relay refused the channel.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not create channel.",
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
        + New channel
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <p className="text-sm font-medium">New channel</p>
      <Input
        placeholder="name (no spaces)"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoFocus
      />
      <Input
        placeholder="What's it about? (optional)"
        value={about}
        onChange={(event) => setAbout(event.target.value)}
      />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => setIsPrivate(event.target.checked)}
        />
        Private (invite-only members)
      </label>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !name.trim()}
          onClick={() => void create()}
        >
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}
