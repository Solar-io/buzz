import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { useProfiles } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { ItemHead } from "../lib/itemEvent.ts";
import { usePickCandidates } from "../usePickCandidates.ts";
import { PersonMark, ringFor } from "./ItemBits";
import type { ItemRowContext } from "./itemRowContext.ts";

/**
 * The Owner cell: the owner (a hex for an agent, a circle for a person), or
 * the dashed "Assign" affordance when nobody has it. Either opens the same
 * menu — me, then the channel's agents, then its people, then Unassign.
 */
export function OwnerMenu({
  item,
  ctx,
  compact = false,
}: {
  item: ItemHead;
  ctx: ItemRowContext;
  /** The phone card: a smaller trigger. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const channelIds = useMemo(() => [item.channelId], [item.channelId]);
  const { pubkeys, loading } = usePickCandidates(channelIds, open, ctx);
  const profiles = useProfiles(pubkeys);
  const nameOf = (pubkey: string) =>
    profiles.has(pubkey)
      ? authorLabel(pubkey, profiles)
      : ctx.personName(pubkey);
  const self = ctx.selfPubkey;
  const others = pubkeys.filter((pubkey) => pubkey !== self);
  const agents = others.filter((pubkey) => ctx.isAgent(pubkey));
  const people = others.filter((pubkey) => !ctx.isAgent(pubkey));
  const busy = ctx.busy.has(`${item.channelId ?? ""}|${item.id}`);
  const assign = (owner: string | null) => {
    if (owner !== item.owner) {
      ctx.onUpdate(item, { owner });
    }
  };
  const row = (pubkey: string) => (
    <DropdownMenuItem
      key={pubkey}
      onSelect={() => assign(pubkey)}
      className={cn(pubkey === item.owner && "font-semibold")}
    >
      <PersonMark
        pubkey={pubkey}
        name={nameOf(pubkey)}
        agent={ctx.isAgent(pubkey)}
      />
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={busy}>
        {item.owner ? (
          <button
            type="button"
            aria-label={`Owner: ${ctx.personName(item.owner)}. Change owner`}
            className="flex min-w-0 max-w-full items-center rounded-md py-0.5 pr-1 text-left hover:bg-accent"
          >
            <PersonMark
              pubkey={item.owner}
              name={ctx.personName(item.owner)}
              agent={ctx.isAgent(item.owner)}
              ring={ringFor(item.status)}
            />
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Assign ${item.title}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.25 rounded-[7px] border border-dashed border-line-2 font-semibold text-muted-foreground hover:border-muted-foreground hover:text-foreground",
              compact ? "h-6 px-2 text-2xs" : "h-6 px-2.25 text-xs",
            )}
          >
            <Plus aria-hidden className="size-3" />
            Assign
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80">
        {self && self !== item.owner ? (
          <DropdownMenuItem onSelect={() => assign(self)}>
            Assign to me
          </DropdownMenuItem>
        ) : null}
        {loading ? (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Reading who is in {ctx.channelName(item.channelId) || "the channel"}
            …
          </DropdownMenuLabel>
        ) : null}
        {agents.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs uppercase tracking-[0.06em] text-muted-foreground">
              Agents
            </DropdownMenuLabel>
            {agents.map(row)}
          </>
        ) : null}
        {people.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs uppercase tracking-[0.06em] text-muted-foreground">
              People
            </DropdownMenuLabel>
            {people.map(row)}
          </>
        ) : null}
        {item.owner ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => assign(null)}>
              Unassign
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
