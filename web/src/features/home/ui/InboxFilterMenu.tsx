import { ChevronDown } from "lucide-react";

import {
  INBOX_FILTER_OPTIONS,
  inboxFilterLabel,
  type InboxFilter,
} from "../lib/inboxFilter.ts";
import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/**
 * The inbox's filter picker, in the shape of the desktop's
 * `InboxFilterMenu` — the active filter IS the pane's title, and the caret
 * next to it is the affordance. A row of tabs would spend the same width
 * saying less.
 */
export function InboxFilterMenu({
  filter,
  counts,
  onFilterChange,
}: {
  filter: InboxFilter;
  /** Row count per filter, shown trailing each option. */
  counts: Record<InboxFilter, number>;
  onFilterChange: (filter: InboxFilter) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="inbox-filter-trigger"
          aria-label={`Filter inbox: ${inboxFilterLabel(filter)}`}
          className={cn(
            "-ml-2 inline-flex h-8 items-center gap-1 rounded-lg px-2",
            "text-base font-semibold text-foreground transition-colors",
            "hover:bg-muted/70 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
            "data-[state=open]:bg-muted/70",
          )}
        >
          {inboxFilterLabel(filter)}
          <ChevronDown aria-hidden className="h-4 w-4 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={filter}
          onValueChange={(value) => onFilterChange(value as InboxFilter)}
        >
          {INBOX_FILTER_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              data-testid={`inbox-filter-${option.value}`}
            >
              <span className="flex-1">{option.label}</span>
              <span className="ml-2 tabular-nums text-2xs text-muted-foreground">
                {counts[option.value]}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
