/**
 * The settings two-pane redesign's navigation: the desktop rail (search
 * input, uppercase section labels, one icon item per group) and the
 * narrow-viewport chip row — the same sidebar chrome the shell uses
 * (`bg-sidebar`, `border-sidebar-border`, `sidebar-active` for the selected
 * row). Purely presentational: groups come in pre-filtered, selection goes
 * out via `onSelect`.
 *
 * Every colour is a theme token; the mock's palette was illustrative and is
 * deliberately not hardcoded.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  Bot,
  Database,
  FlaskConical,
  Keyboard,
  Palette,
  Search,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";

import { cn } from "@/shared/lib/cn";

import {
  filterSettingsGroups,
  type SettingsGroupMeta,
  type SettingsGroupId,
} from "./settingsGroups";

const GROUP_ICONS: Record<SettingsGroupId, ReactNode> = {
  account: <User className="h-4 w-4" />,
  notifications: <Bell className="h-4 w-4" />,
  appearance: <Palette className="h-4 w-4" />,
  keyboard: <Keyboard className="h-4 w-4" />,
  community: <Users className="h-4 w-4" />,
  agents: <Bot className="h-4 w-4" />,
  data: <Database className="h-4 w-4" />,
  security: <ShieldCheck className="h-4 w-4" />,
  advanced: <FlaskConical className="h-4 w-4" />,
};

export interface SettingsNavProps {
  /** All groups visible on this device (iOS already filtered out). */
  groups: readonly SettingsGroupMeta[];
  active: SettingsGroupId;
  onSelect: (id: SettingsGroupId) => void;
  /**
   * Group id carrying the amber attention badge (Security & devices while a
   * key backup is pending). Absent when nothing needs attention.
   */
  attentionGroup?: SettingsGroupId;
  /** Layout hook for the host (the rail owns the sidebar background). */
  className?: string;
}

/** One uppercase label per contiguous run of equal labels, as the nav shows. */
export function navLabelRuns(
  groups: readonly SettingsGroupMeta[],
): { label: string; groups: SettingsGroupMeta[] }[] {
  const runs: { label: string; groups: SettingsGroupMeta[] }[] = [];
  for (const group of groups) {
    const last = runs[runs.length - 1];
    if (last && last.label === group.navLabel) {
      last.groups.push(group);
    } else {
      runs.push({ label: group.navLabel, groups: [group] });
    }
  }
  return runs;
}

function NavItem({
  active,
  attention,
  group,
  onSelect,
}: {
  active: SettingsGroupId;
  attention?: boolean;
  group: SettingsGroupMeta;
  onSelect: (id: SettingsGroupId) => void;
}) {
  const isActive = group.id === active;
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        isActive
          ? "bg-sidebar-active font-semibold text-sidebar-active-foreground"
          : "hover:bg-sidebar-accent/60",
      )}
      data-active={isActive || undefined}
      data-testid={`settings-nav-item-${group.id}`}
      onClick={() => onSelect(group.id)}
      type="button"
    >
      <span className={cn("shrink-0", isActive ? "opacity-100" : "opacity-60")}>
        {GROUP_ICONS[group.id]}
      </span>
      <span className="min-w-0 flex-1 truncate">{group.name}</span>
      {attention ? (
        <span
          className="rounded-full bg-amber-500 px-1.5 py-px text-2xs font-bold leading-tight text-black"
          data-testid="settings-nav-badge-security"
        >
          1
        </span>
      ) : null}
    </button>
  );
}

export function SettingsNav({
  active,
  attentionGroup,
  className,
  groups,
  onSelect,
}: SettingsNavProps) {
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () => filterSettingsGroups(query, groups),
    [groups, query],
  );

  return (
    <div
      className={cn("flex flex-col gap-1 px-2.5 pb-3", className)}
      data-testid="settings-nav"
    >
      <div className="relative mx-1 mb-1.5 shrink-0">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          aria-label="Search settings"
          className="w-full rounded-md border border-border/60 bg-card py-1.5 pr-2.5 pl-8 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary"
          data-testid="settings-nav-search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter activates the first match, then clears so the full nav
            // is one keystroke away again.
            if (event.key === "Enter" && matches.length > 0) {
              onSelect(matches[0].id);
              setQuery("");
            }
          }}
          placeholder="Search settings…"
          type="text"
          value={query}
        />
      </div>

      <div className="buzz-sidebar-scrollbar min-h-0 flex-1 overflow-y-auto">
        {navLabelRuns(matches).map((run) => (
          <div key={run.label}>
            <p className="px-2.5 pt-3 pb-1 text-2xs font-semibold tracking-widest text-muted-foreground/70 uppercase">
              {run.label}
            </p>
            {run.groups.map((group) => (
              <NavItem
                active={active}
                attention={attentionGroup === group.id}
                group={group}
                key={group.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
        {matches.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            No settings match “{query.trim()}”.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Narrow-viewport companion: the same groups as a horizontally scrollable
 * chip row rendered above the content pane.
 */
export function SettingsChipRow({
  active,
  groups,
  onSelect,
}: {
  active: SettingsGroupId;
  groups: readonly SettingsGroupMeta[];
  onSelect: (id: SettingsGroupId) => void;
}) {
  return (
    <div
      className="flex gap-1.5 overflow-x-auto px-3 py-2"
      data-testid="settings-chip-row"
    >
      {groups.map((group) => {
        const isActive = group.id === active;
        return (
          <button
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors",
              isActive
                ? "border-sidebar-active bg-sidebar-active font-semibold text-sidebar-active-foreground"
                : "border-border bg-card hover:border-primary",
            )}
            data-testid={`settings-chip-${group.id}`}
            key={group.id}
            onClick={() => onSelect(group.id)}
            type="button"
          >
            {group.name}
          </button>
        );
      })}
    </div>
  );
}
