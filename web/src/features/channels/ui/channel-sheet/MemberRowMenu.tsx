import { Ban, Clock, MoreHorizontal, UserMinus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

export function MemberRowMenu({
  label,
  canRemove,
  canModerate,
  protectedOwner,
  busy,
  onRemove,
  onModerate,
}: {
  label: string;
  canRemove: boolean;
  canModerate: boolean;
  protectedOwner: boolean;
  busy: boolean;
  onRemove: () => void;
  onModerate: (action: "timeout" | "ban") => void;
}) {
  if (!canRemove && !canModerate) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for ${label}`}
          disabled={busy}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-accent disabled:opacity-50"
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
        {canRemove && (
          <DropdownMenuItem
            className="min-h-11 text-coral-ink focus:text-coral-ink"
            disabled={protectedOwner || busy}
            title={protectedOwner ? "A channel needs an owner" : undefined}
            onSelect={onRemove}
          >
            <UserMinus aria-hidden />
            Remove from channel
          </DropdownMenuItem>
        )}
        {canRemove && canModerate && <DropdownMenuSeparator />}
        {canModerate && (
          <>
            <DropdownMenuItem
              className="min-h-11"
              disabled={busy}
              onSelect={() => onModerate("timeout")}
            >
              <Clock aria-hidden />
              Time out from community…
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 text-coral-ink focus:text-coral-ink"
              disabled={busy}
              onSelect={() => onModerate("ban")}
            >
              <Ban aria-hidden />
              Ban from community…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
