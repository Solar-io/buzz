import { useMemo, useState } from "react";

import { useProfiles } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { cn } from "@/shared/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { HexAvatar } from "@/shared/ui/HexAvatar";
import type { ItemHead } from "../lib/itemEvent.ts";
import { usePickCandidates } from "../usePickCandidates.ts";
import type { ItemRowContext } from "./itemRowContext.ts";

/**
 * "Hand to an agent…" (Items artboard), for one row or the bulk bar. Offers
 * only agents who are members of every source channel involved — the
 * handoff is posted in each, and the agent becomes each item's owner.
 */
export function HandOffDialog({
  items,
  ctx,
  onClose,
  onConfirm,
}: {
  /** Null when closed. */
  items: readonly ItemHead[] | null;
  ctx: ItemRowContext;
  onClose: () => void;
  onConfirm: (input: {
    items: readonly ItemHead[];
    seat: { pubkey: string; name: string };
    note: string;
  }) => Promise<boolean>;
}) {
  const open = items !== null;
  const list = useMemo(
    () => (items ?? []).filter((item) => item.channelId !== null),
    [items],
  );
  const skipped = (items?.length ?? 0) - list.length;
  const channelIds = useMemo(
    () => [...new Set(list.map((item) => item.channelId))],
    [list],
  );
  const { pubkeys, loading } = usePickCandidates(channelIds, open, ctx);
  const agents = pubkeys.filter((pubkey) => ctx.isAgent(pubkey));
  const profiles = useProfiles(agents);
  const nameOf = (pubkey: string) =>
    profiles.has(pubkey)
      ? authorLabel(pubkey, profiles)
      : ctx.personName(pubkey);
  const [seat, setSeat] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const where = channelIds
    .map((id) => ctx.channelName(id) || "its channel")
    .join(", ");
  const close = () => {
    setSeat(null);
    setNote("");
    onClose();
  };
  const confirm = async () => {
    if (seat === null || list.length === 0) {
      return;
    }
    setSending(true);
    const done = await onConfirm({
      items: list,
      seat: { pubkey: seat, name: nameOf(seat) },
      note,
    });
    setSending(false);
    if (done) {
      close();
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="max-w-md gap-3.5" data-testid="handoff-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg">Hand to an agent</DialogTitle>
          <DialogDescription>
            {list.length === 1
              ? `Posts a handoff in ${where} and makes the agent its owner.`
              : `Posts a handoff for ${list.length} items in ${where} and makes the agent their owner.`}
            {skipped > 0
              ? ` ${skipped} filed without a channel ${skipped === 1 ? "is" : "are"} left out.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <fieldset className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          <legend className="sr-only">Agent</legend>
          {loading ? (
            <p className="py-2 text-sm text-muted-foreground">
              Reading who is in {where}…
            </p>
          ) : agents.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No agent is a member of {where}
              {channelIds.length > 1 ? " — of all of them" : ""}. Add one there
              first.
            </p>
          ) : (
            agents.map((pubkey) => (
              <label
                key={pubkey}
                className={cn(
                  "flex h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 text-sm has-focus-visible:ring-2 has-focus-visible:ring-ring",
                  seat === pubkey
                    ? "border-foreground bg-accent font-semibold"
                    : "border-transparent hover:bg-accent",
                )}
              >
                <input
                  type="radio"
                  name="handoff-seat"
                  value={pubkey}
                  checked={seat === pubkey}
                  onChange={() => setSeat(pubkey)}
                  className="sr-only"
                />
                <HexAvatar label={nameOf(pubkey)} seed={pubkey} size={20} />
                <span className="truncate">{nameOf(pubkey)}</span>
              </label>
            ))
          )}
        </fieldset>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anything to add? (optional)"
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm outline-hidden placeholder:text-muted-foreground focus:border-foreground"
        />
        <DialogFooter>
          <button
            type="button"
            onClick={close}
            className="h-9 rounded-lg border border-border px-3.5 text-sm font-semibold hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={seat === null || sending || list.length === 0}
            onClick={() => void confirm()}
            className="h-9 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Handing off…" : "Hand off"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
