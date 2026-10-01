import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { CATEGORY_LABEL, SHELF_CATEGORIES } from "../lib/fileKind.ts";
import type {
  CategoryFilter,
  ChannelFilter,
  SenderFilter,
  ShelfFilters,
} from "../lib/shelfView.ts";

interface MenuOption {
  key: string;
  label: string;
  pick: () => void;
}

function FilterMenu({
  label,
  active,
  options,
  selectedKey,
  testId,
}: {
  label: string;
  active: boolean;
  options: Array<MenuOption | "separator">;
  selectedKey: string;
  testId: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border bg-card px-2.5 text-xs font-semibold",
            active
              ? "border-foreground/40 text-foreground"
              : "border-border text-ink-2 hover:text-foreground",
          )}
        >
          {label}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80">
        {options.map((option, index) =>
          option === "separator" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
            <DropdownMenuSeparator key={`separator-${index}`} />
          ) : (
            <DropdownMenuItem key={option.key} onSelect={option.pick}>
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

function senderKey(sender: SenderFilter): string {
  return typeof sender === "string" ? sender : `pk:${sender.pubkey}`;
}

function channelKey(channel: ChannelFilter): string {
  return typeof channel === "string" ? channel : `ch:${channel.id}`;
}

/**
 * Type chips with their file counts, then From and In (Shelf artboard). A
 * type with nothing in it has no chip — a "Code 0" button is a control with
 * nothing behind it. On a phone the row scrolls sideways.
 */
export function ShelfToolbar({
  narrow,
  filters,
  counts,
  senders,
  channels,
  personName,
  channelName,
  onChange,
}: {
  narrow: boolean;
  filters: ShelfFilters;
  counts: Record<CategoryFilter, number>;
  senders: string[];
  channels: string[];
  personName: (pubkey: string) => string;
  channelName: (id: string) => string;
  onChange: (next: Partial<ShelfFilters>) => void;
}) {
  const chips: CategoryFilter[] = [
    "all",
    ...SHELF_CATEGORIES.filter(
      (category) => counts[category] > 0 || filters.category === category,
    ),
  ];
  const senderLabel =
    filters.sender === "anyone"
      ? "anyone"
      : filters.sender === "me"
        ? "me"
        : personName(filters.sender.pubkey);
  const channelLabel =
    filters.channel === "anywhere"
      ? "anywhere"
      : channelName(filters.channel.id);
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 overflow-x-auto border-b border-border [scrollbar-width:none]",
        narrow ? "px-4 pt-1 pb-2.5" : "px-5 py-2.5",
      )}
    >
      <fieldset className="flex shrink-0 gap-1.5">
        <legend className="sr-only">File type</legend>
        {chips.map((category) => {
          const on = filters.category === category;
          return (
            <button
              key={category}
              type="button"
              aria-pressed={on}
              data-testid={`shelf-type-${category}`}
              onClick={() => onChange({ category })}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.75 rounded-lg border px-2.75 text-xs font-semibold",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-ink-2 hover:text-foreground",
              )}
            >
              {category === "all" ? "All" : CATEGORY_LABEL[category]}
              <span className="font-mono text-2xs opacity-75">
                {counts[category]}
              </span>
            </button>
          );
        })}
      </fieldset>
      <span className="ml-auto flex shrink-0 gap-1.5 pl-3">
        <FilterMenu
          testId="shelf-filter-sender"
          label={`From: ${senderLabel}`}
          active={filters.sender !== "anyone"}
          selectedKey={senderKey(filters.sender)}
          options={[
            {
              key: "anyone",
              label: "Anyone",
              pick: () => onChange({ sender: "anyone" }),
            },
            { key: "me", label: "Me", pick: () => onChange({ sender: "me" }) },
            ...(senders.length > 0 ? (["separator"] as const) : []),
            ...senders.map((pubkey) => ({
              key: `pk:${pubkey}`,
              label: personName(pubkey),
              pick: () => onChange({ sender: { pubkey } }),
            })),
          ]}
        />
        <FilterMenu
          testId="shelf-filter-channel"
          label={`In: ${channelLabel}`}
          active={filters.channel !== "anywhere"}
          selectedKey={channelKey(filters.channel)}
          options={[
            {
              key: "anywhere",
              label: "Anywhere",
              pick: () => onChange({ channel: "anywhere" }),
            },
            ...(channels.length > 0 ? (["separator"] as const) : []),
            ...channels.map((id) => ({
              key: `ch:${id}`,
              label: channelName(id),
              pick: () => onChange({ channel: { id } }),
            })),
          ]}
        />
      </span>
    </div>
  );
}
