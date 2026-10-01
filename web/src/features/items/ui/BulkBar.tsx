import { X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { ItemType } from "../lib/itemEvent.ts";

const SECONDARY =
  "h-7.5 shrink-0 whitespace-nowrap rounded-lg bg-primary-foreground/12 px-3 text-xs font-semibold text-primary-foreground hover:bg-primary-foreground/20 disabled:opacity-50";

/**
 * The selection bar (Items artboard): what is selected, and the three things
 * that make sense for many items at once.
 */
export function BulkBar({
  count,
  narrow,
  busy,
  canHandOff,
  onHandOff,
  onSetType,
  onMarkDone,
  onClear,
}: {
  count: number;
  narrow: boolean;
  busy: boolean;
  /** At least one selected item has a source channel to post in. */
  canHandOff: boolean;
  onHandOff: () => void;
  onSetType: (type: ItemType) => void;
  onMarkDone: () => void;
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label={`${count} selected`}
      data-testid="items-bulk-bar"
      className={cn(
        "absolute z-20 flex items-center gap-1.5 rounded-xl bg-primary py-1.5 pr-1.5 pl-4 text-sidebar-meta text-primary-foreground shadow-elev",
        narrow
          ? "inset-x-3 bottom-3"
          : "bottom-6 left-1/2 max-w-[calc(100%-3rem)] -translate-x-1/2",
      )}
    >
      <b className="mr-auto shrink-0 pr-2 font-semibold whitespace-nowrap">
        {count} selected
      </b>
      <button
        type="button"
        disabled={busy || !canHandOff}
        onClick={onHandOff}
        className="h-7.5 shrink-0 whitespace-nowrap rounded-lg bg-primary-foreground px-3 text-xs font-semibold text-primary hover:bg-primary-foreground/90 disabled:opacity-50"
      >
        {narrow ? "Hand off…" : "Hand to an agent…"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={busy}>
          <button type="button" className={SECONDARY}>
            {narrow ? "Type" : "Change type"}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top">
          <DropdownMenuItem onSelect={() => onSetType("bug")}>
            Make {count === 1 ? "it a bug" : "them bugs"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSetType("backlog")}>
            Move {count === 1 ? "it" : "them"} to backlog
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        disabled={busy}
        onClick={onMarkDone}
        className={SECONDARY}
      >
        {narrow ? "Done" : "Mark done"}
      </button>
      <button
        type="button"
        aria-label="Clear selection"
        onClick={onClear}
        className="grid size-7.5 shrink-0 place-items-center rounded-lg text-primary-foreground/70 hover:text-primary-foreground"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
