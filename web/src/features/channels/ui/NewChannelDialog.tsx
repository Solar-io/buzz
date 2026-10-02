import { useId, useState } from "react";
import { toast } from "sonner";
import {
  CHANNEL_LIFETIMES,
  type ChannelLifetime,
  newChannelRequest,
} from "../lib/newChannelRequest.ts";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Create a channel: kind 9007 with type and optional idle lifetime (mirrors
 * buzz-sdk build_create_channel). The relay emits the 39000 metadata that
 * lands it in every channel list.
 */
export function NewChannelDialog({
  onCreated,
  open: openProp,
  onOpenChange,
}: {
  onCreated: (channelId: string) => void;
  /** Controlled mode (sidebar + button) — renders no trigger of its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp ?? openInternal;
  const setOpen = (next: boolean) => {
    setOpenInternal(next);
    onOpenChange?.(next);
  };
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [type, setType] = useState<"stream" | "forum">("stream");
  const [lifetime, setLifetime] = useState<ChannelLifetime>(0);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const { session } = useRelaySession();

  const create = async () => {
    if (busy) return;
    const channelId = crypto.randomUUID();
    const request = newChannelRequest({
      channelId,
      name,
      about,
      isPrivate,
      type,
      lifetime,
    });
    if ("error" in request) {
      toast.error(request.error);
      return;
    }
    setBusy(true);
    try {
      const event = await signNostrEvent(request.event);
      const result = await session.publish(event);
      if (result.ok) {
        toast.success(`Channel #${request.event.tags[1][1]} created`);
        setOpen(false);
        setName("");
        setAbout("");
        setType("stream");
        setLifetime(0);
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
    if (openProp !== undefined) {
      return null;
    }
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
    <form
      aria-label="New channel"
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <p className="text-sm font-medium">New channel</p>
      <label className="block text-sm" htmlFor={`${formId}-name`}>
        Name
      </label>
      <Input
        id={`${formId}-name`}
        className="h-11"
        disabled={busy}
        placeholder="name (no spaces)"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoFocus
      />
      <label className="block text-sm" htmlFor={`${formId}-about`}>
        Purpose (optional)
      </label>
      <Input
        id={`${formId}-about`}
        className="h-11"
        disabled={busy}
        placeholder="What's it about? (optional)"
        value={about}
        onChange={(event) => setAbout(event.target.value)}
      />
      <fieldset disabled={busy}>
        <legend className="mb-2 text-sm">Type</legend>
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
          {(["stream", "forum"] as const).map((choice) => (
            <label
              key={choice}
              className="relative flex min-h-11 cursor-pointer items-center justify-center"
            >
              <input
                className="peer sr-only"
                type="radio"
                name={`${formId}-type`}
                value={choice}
                checked={type === choice}
                onChange={() => setType(choice)}
              />
              <span className="flex min-h-11 w-full items-center justify-center rounded-md text-sm text-muted-foreground peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                {choice === "stream" ? "Stream" : "Forum"}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-2">
        <label className="block text-sm" htmlFor={`${formId}-lifetime`}>
          Lifetime
        </label>
        <select
          id={`${formId}-lifetime`}
          disabled={busy}
          value={lifetime}
          onChange={(event) =>
            setLifetime(Number(event.target.value) as ChannelLifetime)
          }
          className="h-11 w-full min-w-0 rounded-lg border border-input/40 bg-background px-3 text-base focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
        >
          {CHANNEL_LIFETIMES.map(({ label, seconds }) => (
            <option key={seconds} value={seconds}>
              {label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Temporary channels archive after this long without activity.
        </p>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          disabled={busy}
          checked={isPrivate}
          onChange={(event) => setIsPrivate(event.target.checked)}
        />
        Private (invite-only members)
      </label>
      <div className="flex gap-2">
        <Button
          type="button"
          className="h-11 flex-1"
          variant="ghost"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className="h-11 flex-1"
          disabled={busy || !name.trim()}
        >
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}
