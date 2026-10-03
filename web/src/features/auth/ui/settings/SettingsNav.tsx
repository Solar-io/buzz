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
  BookOpen,
  Headphones,
  KeyRound,
  Hash,
  ChevronRight,
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
  filterSettingsAgents,
  type SettingsAgent,
  type SettingsGroupMeta,
  type SettingsGroupId,
} from "./settingsGroups";

const GROUP_ICONS: Record<SettingsGroupId, ReactNode> = {
  accounts: <KeyRound className="h-4 w-4" />,
  library: <BookOpen className="h-4 w-4" />,
  voice: <Headphones className="h-4 w-4" />,
  channels: <Hash className="h-4 w-4" />,
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
  agents?: readonly SettingsAgent[];
  onSelectAgent?: (pubkey: string) => void;
  phoneRoot?: boolean;
  footer?: ReactNode;
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
  phoneRoot,
}: {
  active: SettingsGroupId;
  phoneRoot?: boolean;
  attention?: boolean;
  group: SettingsGroupMeta;
  onSelect: (id: SettingsGroupId) => void;
}) {
  const isActive = !phoneRoot && group.id === active;
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        phoneRoot &&
          "min-h-12 rounded-none border-b border-border last:border-0",
        isActive
          ? "bg-sidebar-active font-semibold text-sidebar-active-foreground"
          : "hover:bg-sidebar-accent/60",
      )}
      aria-current={isActive ? "page" : undefined}
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
          className="rounded-full bg-honey px-1.5 py-px text-2xs font-bold leading-tight text-honey-ink"
          data-testid="settings-nav-badge-security"
        >
          1
        </span>
      ) : null}
      {phoneRoot ? (
        <ChevronRight aria-hidden className="h-4 w-4 text-muted-foreground" />
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
  agents = [],
  onSelectAgent,
  phoneRoot = false,
  footer,
}: SettingsNavProps) {
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () => filterSettingsGroups(query, groups, agents),
    [groups, query, agents],
  );

  const agentMatches = filterSettingsAgents(query, agents);
  return (
    <div
      className={cn("flex flex-col gap-1 px-2.5 pb-3", className)}
      data-testid={phoneRoot ? "settings-root-list" : "settings-nav"}
    >
      {phoneRoot ? footer : null}
      <div className="relative mx-1 mb-1.5 shrink-0">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          aria-label="Search settings"
          className="w-full rounded-md border border-border/60 bg-card min-h-11 md:min-h-0 py-1.5 pr-2.5 pl-8 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary"
          data-testid="settings-nav-search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter activates the first match, then clears so the full nav
            // is one keystroke away again.
            if (
              event.key === "Enter" &&
              (matches.length > 0 || agentMatches.length > 0)
            ) {
              if (agentMatches.length && onSelectAgent)
                onSelectAgent(agentMatches[0].pubkey);
              else if (matches.length) onSelect(matches[0].id);
              setQuery("");
            }
          }}
          placeholder="Find a setting or agent…"
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
            <div
              className={
                phoneRoot
                  ? "overflow-hidden rounded-xl border border-border bg-card"
                  : undefined
              }
            >
              {run.groups.map((group) => (
                <NavItem
                  active={active}
                  phoneRoot={phoneRoot}
                  attention={attentionGroup === group.id}
                  group={group}
                  key={group.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        ))}
        {agentMatches.map((agent) => (
          <button
            key={agent.pubkey}
            type="button"
            className="flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm hover:bg-sidebar-accent"
            onClick={() => {
              onSelectAgent?.(agent.pubkey);
              setQuery("");
            }}
          >
            <Bot aria-hidden className="h-4 w-4" />
            {agent.name}
          </button>
        ))}
        {matches.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            No settings match “{query.trim()}”.
          </p>
        ) : null}
      </div>
      {!phoneRoot ? footer : null}
    </div>
  );
}
