import { TriangleAlert } from "lucide-react";
import { Button } from "@/shared/ui/button";

/** Cleanup removes channel memberships only; it never unregisters or deletes a key. */
export function UnregisteredBanner({
  count,
  canRemove,
  busy,
  onRemove,
}: {
  count: number;
  canRemove: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  if (!count) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-honey-line bg-honey-wash p-3">
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-honey-ink" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {count} {count === 1 ? "agent isn't" : "agents aren't"} registered
          anywhere.
        </p>
        <p className="text-xs text-muted-foreground">
          Old keys and retired seats. They still count as members.
        </p>
      </div>
      {canRemove && (
        <Button
          className="min-h-11 shrink-0"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onRemove}
        >
          Remove {count}
        </Button>
      )}
    </div>
  );
}
