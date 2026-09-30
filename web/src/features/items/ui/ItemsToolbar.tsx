import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { ITEM_STATUSES } from "../lib/itemEvent.ts";
import {
  type ItemFilters,
  type ItemsTab,
  type OwnerFilter,
  type ProjectFilter,
  STATUS_LABEL,
  type StatusFilter,
  statusFilterLabel,
} from "../lib/itemsView.ts";
import type { ItemsLayout } from "./itemRowContext.ts";

const TABS: Array<[ItemsTab, string]> = [
  ["all", "All"],
  ["bug", "Bugs"],
  ["backlog", "Backlog"],
];

interface Option<T> {
  value: T;
  label: ReactNode;
  key: string;
}

function FacetMenu<T>({
  label,
  active,
  options,
  selectedKey,
  onPick,
  testId,
}: {
  label: string;
  /** Not the default — the button reads as set. */
  active: boolean;
  options: Array<Option<T> | "separator">;
  selectedKey: string;
  onPick: (value: T) => void;
  testId: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-semibold",
            active
              ? "border-foreground/40 bg-card text-foreground"
              : "border-border bg-card text-ink-2 hover:text-foreground",
          )}
        >
          {label}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80">
        {options.map((option, index) =>
          option === "separator" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
            <DropdownMenuSeparator key={`separator-${index}`} />
          ) : (
            <DropdownMenuItem
              key={option.key}
              onSelect={() => onPick(option.value)}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {option.key === selectedKey ? (
                  <Check aria-hidden className="size-3.5" />
                ) : null}
              </span>
              <span className="min-w-0 truncate">{option.label}</span>
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ownerKey(owner: OwnerFilter): string {
  return typeof owner === "string" ? owner : `pk:${owner.pubkey}`;
}

function projectKey(project: ProjectFilter): string {
  return typeof project === "string" ? project : `name:${project.name}`;
}

/**
 * Tabs with counts, then Project / Owner / Status (Items artboard). On a
 * phone the two groups wrap into two scrolling rows.
 */
export function ItemsToolbar({
  layout,
  filters,
  tabCounts,
  shown,
  total,
  projects,
  owners,
  personName,
  onChange,
}: {
  layout: ItemsLayout;
  filters: ItemFilters;
  tabCounts: Record<ItemsTab, number>;
  shown: number;
  total: number;
  projects: { names: string[]; hasNone: boolean };
  owners: string[];
  personName: (pubkey: string) => string;
  onChange: (next: Partial<ItemFilters>) => void;
}) {
  const narrow = layout === "narrow";
  const projectOptions: Array<Option<ProjectFilter> | "separator"> = [
    { value: "all", label: "All projects", key: "all" },
    ...(projects.names.length > 0 ? ["separator" as const] : []),
    ...projects.names.map((name) => ({
      value: { name },
      label: name,
      key: `name:${name}`,
    })),
    ...(projects.hasNone
      ? [
          "separator" as const,
          { value: "none" as const, label: "No project", key: "none" },
        ]
      : []),
  ];
  const ownerOptions: Array<Option<OwnerFilter> | "separator"> = [
    { value: "any", label: "Anyone", key: "any" },
    { value: "me", label: "Me", key: "me" },
    { value: "none", label: "Nobody yet", key: "none" },
    ...(owners.length > 0 ? ["separator" as const] : []),
    ...owners.map((pubkey) => ({
      value: { pubkey },
      label: personName(pubkey),
      key: `pk:${pubkey}`,
    })),
  ];
  const statusOptions: Array<Option<StatusFilter> | "separator"> = [
    { value: "active", label: "Not done", key: "active" },
    "separator",
    ...ITEM_STATUSES.map((status) => ({
      value: status,
      label: STATUS_LABEL[status],
      key: status,
    })),
    "separator",
    { value: "all", label: "Any status", key: "all" },
  ];
  const ownerLabel =
    filters.owner === "any"
      ? "Any"
      : filters.owner === "me"
        ? "Me"
        : filters.owner === "none"
          ? "Nobody"
          : personName(filters.owner.pubkey);
  const projectLabel =
    filters.project === "all"
      ? "All"
      : filters.project === "none"
        ? "None"
        : filters.project.name;

  const tabs = (
    <div
      role="tablist"
      aria-label="Item type"
      className="flex shrink-0 gap-1.5"
    >
      {TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={filters.tab === id}
          data-testid={`items-tab-${id}`}
          onClick={() => onChange({ tab: id })}
          className={cn(
            "inline-flex h-7 items-center gap-1.75 rounded-lg border px-2.75 text-xs font-semibold",
            filters.tab === id
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-ink-2 hover:text-foreground",
          )}
        >
          {label}
          <span className="font-mono text-2xs opacity-75">{tabCounts[id]}</span>
        </button>
      ))}
    </div>
  );
  const facets = (
    <div className="flex shrink-0 gap-1.5">
      <FacetMenu
        testId="items-filter-project"
        label={`Project: ${projectLabel}`}
        active={filters.project !== "all"}
        options={projectOptions}
        selectedKey={projectKey(filters.project)}
        onPick={(project) => onChange({ project })}
      />
      <FacetMenu
        testId="items-filter-owner"
        label={`Owner: ${ownerLabel}`}
        active={filters.owner !== "any"}
        options={ownerOptions}
        selectedKey={ownerKey(filters.owner)}
        onPick={(owner) => onChange({ owner })}
      />
      <FacetMenu
        testId="items-filter-status"
        label={`Status: ${statusFilterLabel(filters.status)}`}
        active={filters.status !== "active"}
        options={statusOptions}
        selectedKey={filters.status}
        onPick={(status) => onChange({ status })}
      />
    </div>
  );
  const countLabel = (
    <span
      data-testid="items-shown"
      className="shrink-0 font-mono text-2xs text-muted-foreground"
    >
      newest first ·{" "}
      {shown === total ? `${total}` : `showing ${shown} of ${total}`}
    </span>
  );
  if (narrow) {
    return (
      <div className="flex flex-col gap-2 border-b border-border px-4 pt-1 pb-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto">{tabs}</div>
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {facets}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 border-b border-border px-6 py-2.5">
      {tabs}
      <span aria-hidden className="mx-1.5 h-5 w-px bg-border" />
      {facets}
      <span className="ml-auto pl-3">{countLabel}</span>
    </div>
  );
}
