import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/** Props for {@link SectionHeader}. */
export interface SectionHeaderProps {
  label: string;
  /** The section is folded; the chevron turns −90° and the count shows. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Item count, rendered only while collapsed (null hides it). */
  count?: number | null;
  /** Accent dot: collapsed and something inside is unread. */
  unreadDot?: boolean;
  /** Shows the + button when provided (Channels, Direct messages, Links). */
  onAdd?: () => void;
  addLabel?: string;
  /** A quiet mono hint at the right end — Scratch's "/new". */
  hint?: string;
  className?: string;
}

/**
 * Collapsible sidebar section header (left-nav redesign, 2026-09-28): 28px,
 * 12px uppercase semibold label, a chevron that rotates −90° when collapsed,
 * and — while collapsed — the item count plus an accent dot when anything
 * inside is unread, so folding a section never hides that it has news.
 */
export function SectionHeader({
  label,
  collapsed,
  onToggleCollapsed,
  count,
  unreadDot,
  onAdd,
  addLabel,
  hint,
  className,
}: SectionHeaderProps) {
  return (
    <div
      data-testid="sidebar-section-header"
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "flex h-7 items-center rounded-[6px] pl-1.5 pr-1 text-xs font-semibold uppercase tracking-[.02em] text-sidebar-foreground/60 transition-colors hover:bg-sidebar-foreground/5",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left uppercase"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-2.5 shrink-0 transition-transform duration-150",
            collapsed && "-rotate-90",
          )}
        />
        <span className="truncate">{label}</span>
        {collapsed && count != null && (
          // Collapsing must not make rows vanish without trace.
          <span
            data-testid="section-count"
            className="shrink-0 font-medium normal-case tracking-normal text-sidebar-foreground/45"
          >
            {count}
          </span>
        )}
        {collapsed && unreadDot && (
          <span
            data-testid="section-unread-dot"
            className="size-1.5 shrink-0 rounded-full bg-sidebar-active"
          >
            <span className="sr-only">Unread</span>
          </span>
        )}
      </button>
      {hint && (
        <span className="shrink-0 pr-1.5 font-mono text-2xs font-medium normal-case tracking-normal">
          {hint}
        </span>
      )}
      {onAdd && (
        <button
          type="button"
          aria-label={addLabel ?? label}
          title={addLabel ?? label}
          className="flex size-5.5 shrink-0 items-center justify-center rounded-[5px] text-sidebar-foreground/60 hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground"
          onClick={onAdd}
        >
          <Plus aria-hidden className="size-3.25" />
        </button>
      )}
    </div>
  );
}
