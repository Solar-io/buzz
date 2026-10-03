import type { ReactNode } from "react";
import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import type { RosterViewRow } from "../lib/rosterView";

export function RosterRow({
  row,
  profile,
  columns,
  selected,
  disabled,
  onSelect,
  onOpen,
  menu,
}: {
  row: RosterViewRow;
  profile?: Profile;
  columns: string[];
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onOpen: () => void;
  menu: ReactNode;
}) {
  const checkbox = (
    <label className="flex h-11 w-11 shrink-0 items-center justify-center">
      <input
        type="checkbox"
        aria-label={`Select ${row.name}`}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        className="h-4 w-4 accent-primary"
      />
    </label>
  );
  const identity = (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-11 min-w-0 items-center gap-2 text-left"
      aria-label={`Open ${row.name}`}
    >
      <span
        className={`buzz-hex h-9 w-9 shrink-0 p-0.5 ${row.status === "Working" ? "bg-work" : "bg-idle-ring"}`}
      >
        <AuthorAvatar
          pubkey={row.pubkey}
          label={row.name}
          picture={profile?.avatar}
          className="buzz-hex h-full w-full rounded-none bg-idle-hex text-xs text-idle-hex-ink"
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{row.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.teams.join(" · ") || "Standalone"}
        </span>
      </span>
    </button>
  );
  const status = (
    <span
      className={`flex items-center gap-1.5 text-xs ${row.status === "Working" ? "text-honey-ink" : "text-muted-foreground"}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.status === "Working" ? "bg-work" : "bg-muted-foreground/50"}`}
      />
      <span>{row.status}</span>
    </span>
  );
  if (columns.length === 3)
    return (
      <li
        data-testid="roster-row"
        className="flex items-start border-b border-border py-2 last:border-0"
      >
        {checkbox}
        <div className="min-w-0 flex-1 space-y-1">
          {identity}
          {status}
          {row.model ? (
            <p
              className="truncate text-xs text-muted-foreground"
              title={row.model}
            >
              {row.model}
            </p>
          ) : null}
        </div>
        {menu}
      </li>
    );
  const effort = row.entry.effort;
  const values: Record<string, ReactNode> = {
    Agent: identity,
    Status: status,
    Model: row.model,
    Effort: effort?.acp ?? effort?.thinking ?? effort?.claudeCode,
    "Voice turns": effort?.voiceTurn,
    Runtime: row.persona?.runtime,
  };
  return (
    <tr
      data-testid="roster-row"
      className="border-b border-border last:border-0 hover:bg-muted/30"
    >
      <td>{checkbox}</td>
      {columns.map((column) => (
        <td key={column} className="min-w-0 px-2 py-2 text-sm">
          <div
            className="truncate"
            title={
              typeof values[column] === "string" ? values[column] : undefined
            }
          >
            {values[column] || "—"}
          </div>
        </td>
      ))}
      <td>{menu}</td>
    </tr>
  );
}
