import { Button } from "@/shared/ui/button";
import type { RosterFilter } from "../lib/rosterView";

export function RosterFilters({
  counts,
  status,
  team,
  query,
  teams,
  onStatus,
  onTeam,
  onQuery,
}: {
  counts: Record<RosterFilter, number>;
  status: RosterFilter;
  team: string;
  query: string;
  teams: string[];
  onStatus: (value: RosterFilter) => void;
  onTeam: (value: string) => void;
  onQuery: (value: string) => void;
}) {
  return (
    <div
      role="group"
      className="flex flex-wrap items-center gap-2"
      aria-label="Roster filters"
    >
      {(Object.keys(counts) as RosterFilter[]).map((filter) => (
        <Button
          key={filter}
          className="h-11 rounded-full px-3 text-xs"
          variant={status === filter ? "default" : "outline"}
          aria-pressed={status === filter}
          onClick={() => onStatus(filter)}
        >
          {filter} <span className="tabular-nums">{counts[filter]}</span>
        </Button>
      ))}
      <select
        aria-label="Filter by team"
        className="h-11 min-w-0 max-w-full rounded-lg border border-input bg-background px-3 text-sm"
        value={team}
        onChange={(event) => onTeam(event.target.value)}
      >
        <option value="">All teams</option>
        {teams.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
      <input
        aria-label="Filter agents"
        placeholder="Filter by name, model…"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
      />
    </div>
  );
}
