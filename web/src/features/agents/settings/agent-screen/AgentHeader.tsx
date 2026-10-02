import {
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  MoreHorizontal,
  RotateCw,
  Square,
} from "lucide-react";
import { Button } from "@/shared/ui/button";
import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import type { Profile } from "@/features/channels/hooks";
import type { RosterRow } from "../../lib/roster";
import { rosterPosition } from "./agentScreenModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

export function AgentHeader({
  row,
  profile,
  roster,
  teams,
  statusLine,
  working,
  enabled,
  restartEnabled,
  busy,
  onBack,
  onSelect,
  onMessage,
  onLifecycle,
  onExport,
  onUnregister,
}: {
  row: RosterRow;
  profile?: Profile;
  roster: readonly RosterRow[];
  teams: readonly string[];
  statusLine: string;
  working: boolean;
  enabled: boolean;
  restartEnabled: boolean;
  busy: boolean;
  onBack: () => void;
  onSelect: (pubkey: string) => void;
  onMessage: () => void;
  onLifecycle: (action: "start" | "stop" | "restart") => void;
  onExport: () => void;
  onUnregister: () => void;
}) {
  const position = rosterPosition(roster, row.pubkey);
  return (
    <header className="space-y-4" data-testid="agent-header">
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-0 md:min-h-8"
          onClick={onBack}
        >
          ← Agents
        </Button>
        <div className="flex items-center gap-1">
          <span
            className="font-mono text-xs"
            data-testid="agent-roster-position"
          >
            {position.position} of {position.total}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-11 w-11 md:h-8 md:w-8"
            aria-label="Previous agent"
            disabled={!position.previous}
            onClick={() => position.previous && onSelect(position.previous)}
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-11 w-11 md:h-8 md:w-8"
            aria-label="Next agent"
            disabled={!position.next}
            onClick={() => position.next && onSelect(position.next)}
          >
            <ChevronRight aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={`h-14 w-14 shrink-0 p-0.5 [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)] ${working ? "bg-honey" : "bg-muted-foreground/40"}`}
        >
          <AuthorAvatar
            pubkey={row.pubkey}
            label={profile?.displayName ?? row.name}
            picture={profile?.avatar}
            className="h-full w-full rounded-none bg-muted text-base [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)]"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-xl font-semibold">
              {profile?.displayName ?? row.name}
            </h1>
            {teams.map((team) => (
              <span
                key={team}
                className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {team}
              </span>
            ))}
            {row.personaLinked ? (
              <span className="rounded border border-border px-1.5 text-badge text-muted-foreground">
                Linked
              </span>
            ) : null}
          </div>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {statusLine}
          </p>
        </div>
        <div
          className="flex w-full gap-2 md:w-auto"
          data-testid="agent-action-row"
        >
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 flex-1 md:min-h-8 md:flex-none"
            disabled={!enabled || !restartEnabled || busy}
            onClick={() => onLifecycle("restart")}
          >
            <RotateCw aria-hidden className="mr-1 h-3.5 w-3.5" />
            Restart
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 flex-1 md:min-h-8 md:flex-none"
            disabled={!enabled || busy}
            onClick={() => onLifecycle("stop")}
          >
            <Square aria-hidden className="mr-1 h-3.5 w-3.5" />
            Stop
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 flex-1 md:min-h-8 md:flex-none"
            disabled={busy}
            onClick={onMessage}
          >
            <MessageSquare aria-hidden className="mr-1 h-3.5 w-3.5" />
            Message
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="h-11 w-11 shrink-0 md:h-8 md:w-8"
                aria-label="Agent actions"
              >
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!enabled || busy}
                onSelect={() => onLifecycle("start")}
              >
                Start
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onExport}>
                Export snapshot
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!enabled || busy}
                onSelect={onUnregister}
              >
                Unregister…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
