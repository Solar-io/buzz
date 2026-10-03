import { MoreHorizontal } from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/shared/ui/dropdown-menu";
import type { RosterViewRow } from "../lib/rosterView";
import type { RosterAction } from "../lib/rosterActions";

export function RosterRowMenu({
  row,
  busy,
  allowed,
  onAction,
  onOpen,
  onMessage,
  onExport,
}: {
  row: RosterViewRow;
  busy: boolean;
  allowed: (action: RosterAction) => boolean;
  onAction: (action: RosterAction) => void;
  onOpen: () => void;
  onMessage: () => void;
  onExport: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={`Actions for ${row.name}`}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(["start", "stop", "restart"] as const).map((action) => (
          <DropdownMenuItem
            className="min-h-11"
            key={action}
            disabled={busy || !allowed(action)}
            onSelect={() => onAction(action)}
          >
            {action[0].toUpperCase()}
            {action.slice(1)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-11" onSelect={onOpen}>
          Open
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-11"
          disabled={busy}
          onSelect={onMessage}
        >
          Message
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-11"
          onSelect={onExport}
          disabled={row.personaLinked && !row.persona}
        >
          Export snapshot
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-11 text-coral-ink"
          disabled={busy || !allowed("unregister")}
          onSelect={() => onAction("unregister")}
        >
          Unregister…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
