import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import { useSnapshotFilePicker } from "../ui/ImportSnapshotButton";

/** Creation entry points; linked/team execution belongs to phase P2. */
export function NewAgentMenu({
  catalogs,
  onBlank,
}: {
  catalogs: readonly DesktopCatalog[];
  onBlank: () => void;
}) {
  const picker = useSnapshotFilePicker();
  const hasCap = (cap: string) =>
    catalogs.some(
      (catalog) => catalog.version >= 5 && catalog.caps?.includes(cap),
    );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            <Plus aria-hidden className="size-4" />
            New agent
            <ChevronDown aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
          <DropdownMenuItem onSelect={onBlank}>Blank agent</DropdownMenuItem>
          {[
            ["From a definition", "create.linked"],
            ["From a team", "create.team"],
          ].map(([label, cap]) => (
            <DropdownMenuItem
              key={cap}
              disabled
              className="block whitespace-normal"
            >
              <span>{label}</span>
              <span className="mt-1 block max-w-60 text-xs text-muted-foreground">
                {hasCap(cap)
                  ? "Coming in the next creation update"
                  : "Update Buzz Desktop to create this way"}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!picker.available}
            onSelect={picker.choose}
          >
            Import snapshot…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {picker.input}
    </>
  );
}
