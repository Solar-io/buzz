import { MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/cn";

/**
 * The forum's delete affordance: an overflow menu that opens a confirm dialog.
 *
 * Port of the desktop client's `features/forum/ui/DeleteActionMenu` +
 * `DeleteConfirmDialog` pair. It replaces `window.confirm`, which was wrong
 * here for three separate reasons rather than one aesthetic one:
 *
 *  - it blocks the event loop, so the relay session's socket callbacks and
 *    every animation stall for as long as the sheet is up;
 *  - it renders as browser chrome that looks nothing like the app, and on
 *    some browsers carries a "don't let this page create more dialogs"
 *    checkbox that permanently disables the only confirmation this action has;
 *  - a bare trash glyph offers no way to *see* the destructive action before
 *    committing to it, which is what a menu is for.
 *
 * The dialog is rendered unconditionally (Radix keeps it unmounted while
 * closed) so the menu can close itself the moment the item is chosen — leaving
 * both open at once traps focus between two overlays.
 */
export function DeletePostMenu({
  label,
  onConfirm,
  className,
  testId,
}: {
  /** What is being deleted, lowercase — "post", "reply", "message". */
  label: string;
  onConfirm: () => void;
  className?: string;
  /** Test id for the trigger; the dialog derives its own from it. */
  testId?: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for this ${label}`}
            data-testid={testId}
            className={cn(
              "shrink-0 self-start rounded p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground lg:opacity-0 lg:group-hover:opacity-100",
              className,
            )}
            // The card around this is itself clickable (it opens the thread);
            // without this a click on the menu also navigates.
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onClick={(event) => event.stopPropagation()}
        >
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            data-testid={testId ? `${testId}-delete` : undefined}
            onSelect={() => setConfirmOpen(true)}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            Delete {label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <DialogContent
          data-testid={testId ? `${testId}-dialog` : undefined}
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Delete {label}?</DialogTitle>
            <DialogDescription>
              This will permanently delete this {label} and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirmOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              data-testid={testId ? `${testId}-confirm` : undefined}
              onClick={() => {
                setConfirmOpen(false);
                onConfirm();
              }}
              type="button"
              variant="destructive"
            >
              Delete {label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
