import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { StateHex } from "@/shared/ui/HexAvatar";
import { filterByChip } from "../lib/needsYou.ts";
import type { NeedChipFilter, NeedCounts, NeedRow } from "../lib/workTypes.ts";
import type { ActionSize } from "./NeedActions";
import { NeedRowView, type NeedRowContext } from "./NeedRow";

/** Rows before "Show N more" (phase-1 §2.2). */
export const NEEDS_PAGE = 6;

/** The caps section header the four Work sections share. */
export function SectionHeader({
  label,
  count,
  marker,
  tone,
  collapsed,
  onToggle,
  trailing,
}: {
  label: string;
  count: number | string;
  marker: ReactNode;
  tone: string;
  collapsed: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={cn(
        "flex h-5.5 w-full items-center gap-1.75 px-0.5 text-left text-2xs font-semibold uppercase tracking-[0.08em]",
        tone,
      )}
    >
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-transform",
          collapsed && "-rotate-90",
        )}
      />
      {marker}
      {label}
      <span className="font-mono tracking-normal">{count}</span>
      {trailing ? (
        <span className="ml-auto font-mono text-2xs font-medium normal-case tracking-normal text-muted-foreground">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}

const CHIPS: Array<{
  id: NeedChipFilter;
  label: string;
  count: keyof NeedCounts;
}> = [
  { id: "all", label: "All", count: "all" },
  { id: "approvals", label: "Approvals", count: "approvals" },
  { id: "asks", label: "Asks", count: "asks" },
  { id: "feedback", label: "Feedback", count: "feedback" },
];

export function NeedsYouSection({
  needs,
  counts,
  ctx,
  collapsed,
  onToggle,
  size = "rail",
  showHeader = true,
}: {
  needs: NeedRow[];
  counts: NeedCounts;
  ctx: NeedRowContext;
  collapsed: boolean;
  onToggle: () => void;
  size?: ActionSize;
  showHeader?: boolean;
}) {
  const [chip, setChip] = useState<NeedChipFilter>("all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rows = filterByChip(needs, chip);
  const visible = showAll ? rows : rows.slice(0, NEEDS_PAGE);
  // The first visible row renders expanded; one expanded row at a time.
  // "" = the viewer folded the open row (nothing expanded).
  const expanded =
    expandedKey === ""
      ? null
      : expandedKey !== null && visible.some((row) => row.key === expandedKey)
        ? expandedKey
        : (visible[0]?.key ?? null);
  const page = size === "page";
  // Phone: the two blocking rows up top are cards of their own (PhoneWork).
  const cards = page ? visible.slice(0, 2) : [];
  const listed = page ? visible.slice(2) : visible;

  const showMore =
    rows.length > NEEDS_PAGE ? (
      <button
        type="button"
        onClick={() => setShowAll((value) => !value)}
        className={cn(
          "font-semibold text-info-ink hover:underline",
          page
            ? "h-10 text-center text-sm"
            : "h-8 w-full px-3 text-left text-xs",
        )}
      >
        {showAll ? "Show fewer" : `Show ${rows.length - NEEDS_PAGE} more`}
      </button>
    ) : null;

  return (
    <section aria-label="Needs you" className="flex flex-col gap-1.75">
      {showHeader && (
        <SectionHeader
          label="Needs you"
          count={counts.all}
          tone="text-coral-ink"
          marker={<StateHex tone="need" size={10} />}
          collapsed={collapsed}
          onToggle={onToggle}
          trailing={counts.overdue > 0 ? `${counts.overdue} overdue` : null}
        />
      )}
      {!collapsed && (
        <>
          {!page && counts.all > 0 && (
            <fieldset className="flex min-w-0 flex-wrap gap-1">
              <legend className="sr-only">Filter</legend>
              {CHIPS.filter(
                (entry) => entry.id === "all" || counts[entry.count] > 0,
              ).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={chip === entry.id}
                  onClick={() => {
                    setChip(entry.id);
                    setShowAll(false);
                  }}
                  className={cn(
                    "h-6 rounded-full px-2.25 text-xs font-semibold transition-colors",
                    chip === entry.id
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-ink-2 hover:bg-accent",
                  )}
                >
                  {entry.label} {counts[entry.count]}
                </button>
              ))}
            </fieldset>
          )}
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-3 text-sidebar-meta text-muted-foreground">
              {counts.all === 0
                ? "Nothing needs you right now."
                : "Nothing under this filter."}
            </p>
          ) : (
            <>
              {cards.map((row) => (
                <div
                  key={row.key}
                  className="overflow-hidden rounded-[14px] border border-border bg-card"
                >
                  <NeedRowView
                    row={row}
                    ctx={ctx}
                    size={size}
                    expanded
                    onExpand={() => ctx.onOpen(row)}
                  />
                </div>
              ))}
              {listed.length > 0 && (
                <div
                  className={cn(
                    "overflow-hidden border border-border bg-card",
                    page ? "rounded-[14px]" : "rounded-xl",
                  )}
                >
                  {listed.map((row) => (
                    <NeedRowView
                      key={row.key}
                      row={row}
                      ctx={ctx}
                      size={size}
                      expanded={!page && row.key === expanded}
                      onExpand={() =>
                        page
                          ? ctx.onOpen(row)
                          : setExpandedKey(row.key === expanded ? "" : row.key)
                      }
                    />
                  ))}
                  {/* In the rail the toggle is the card's last row (Main). */}
                  {!page && showMore}
                </div>
              )}
              {page && showMore}
            </>
          )}
        </>
      )}
    </section>
  );
}
