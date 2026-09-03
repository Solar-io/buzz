import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/** Props for {@link SectionHeader}. */
export interface SectionHeaderProps {
  label: string;
  /** Shows the + button when provided (Channels, Direct messages). */
  onAdd?: () => void;
  addLabel?: string;
  className?: string;
  /**
   * "dm" renders the dm-list-spec.md §2 treatment: sentence case, ~13px, ink
   * aligned to the avatar left edge (14px) instead of the uppercase
   * channel-section style. The colour comes from the sidebar tokens — the
   * spec's sampled #8E96B0 was a dark-theme reading of exactly that.
   */
  variant?: "default" | "dm";
  /**
   * Makes the label a collapse toggle. Omit for a static header — "Starred"
   * has no `+` and nothing worth folding.
   */
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Rows hidden by the collapse, surfaced on the header so the count is not lost. */
  itemCount?: number;
}

/**
 * Sidebar section label with the desktop's header-row plus button — the
 * create dialogs open inline just below the header.
 */
export function SectionHeader({
  label,
  onAdd,
  addLabel,
  className,
  variant = "dm",
  collapsible,
  collapsed,
  onToggleCollapsed,
  itemCount,
}: SectionHeaderProps) {
  const labelClass = cn(
    "text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70",
    variant === "dm" &&
      "text-[13px] font-medium normal-case tracking-normal text-sidebar-foreground/60",
  );
  return (
    <div
      className={cn(
        "flex h-8 items-center justify-between pl-2 pr-1",
        variant === "dm" && "pl-[6px]",
        className,
      )}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          className={cn(
            "group/section -ml-1 flex min-w-0 items-center gap-1 rounded px-1 hover:bg-sidebar-accent/50",
            labelClass,
          )}
        >
          {collapsed ? (
            <ChevronRight aria-hidden className="size-3 shrink-0" />
          ) : (
            <ChevronDown aria-hidden className="size-3 shrink-0" />
          )}
          <span className="truncate">{label}</span>
          {collapsed && itemCount !== undefined && itemCount > 0 && (
            // Collapsing must not make rows vanish without trace.
            <span className="shrink-0 text-2xs opacity-70">{itemCount}</span>
          )}
        </button>
      ) : (
        <p className={labelClass}>{label}</p>
      )}
      {onAdd && (
        <button
          type="button"
          aria-label={addLabel ?? label}
          title={addLabel ?? label}
          className="rounded p-1 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
