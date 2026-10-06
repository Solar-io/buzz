import { ChevronRight, MoreHorizontal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
  SIDEBAR_LIST_OPTIONS,
  sectionHeaderState,
  truncateSection,
} from "@/features/sidebar/lib/sectionList.ts";
import { cn } from "@/shared/lib/cn";

/** Props for {@link SidebarNavDisclosure}. */
export interface SidebarNavDisclosureProps<T> {
  label: string;
  /** Leading glyph, the same size as the other nav rows' (size-4). */
  icon: ReactNode;
  /** Already ordered. */
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Keeps the open row visible past the "N more" cutoff. */
  isSelected?: (item: T) => boolean;
  /** Folded, a dot on the row says something inside is unread. */
  isUnread?: (item: T) => boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** A trailing row inside the open list — Links' "Add a link". */
  footer?: ReactNode;
  /** Rendered once, open or folded (Links' add/edit dialog). */
  children?: ReactNode;
  /** Rows before the "N more" row; defaults to SIDEBAR_LIST_OPTIONS. */
  visibleItems?: number;
}

/**
 * A nav row that folds a list under itself: Forums and Links, below
 * Terminal (Sam, 2026-09-30).
 *
 * The button is drawn with the nav rows' recipe (SidebarNavButton: h-8,
 * 7px radius, size-4 glyph, text-sm) so it reads as one of Inbox, Items,
 * Files and Terminal rather than as a section header. Folded, it says what
 * it is holding — a quiet count, and a dot when something inside is unread —
 * so folding never hides news. Open, its rows hang under a guide line, with
 * the sections' own "N more" truncation so a long list cannot swallow the
 * rail.
 *
 * Toggling deliberately does NOT close the phone drawer, unlike a nav row:
 * it opens a list, it does not go anywhere. The rows inside are ordinary
 * SidebarNavButtons and close it themselves.
 */
export function SidebarNavDisclosure<T>({
  label,
  icon,
  items,
  getKey,
  renderItem,
  isSelected,
  isUnread,
  collapsed,
  onToggleCollapsed,
  footer,
  children,
  visibleItems = SIDEBAR_LIST_OPTIONS.visibleItems,
}: SidebarNavDisclosureProps<T>) {
  const listId = useId();
  const [showAll, setShowAll] = useState(false);
  const folded = sectionHeaderState({ items, collapsed, isUnread });
  const list = truncateSection({
    items,
    limit: visibleItems,
    expanded: showAll,
    isSelected,
    isUnread,
  });
  return (
    <div className="flex flex-col gap-px" data-testid="sidebar-nav-disclosure">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : listId}
        onClick={onToggleCollapsed}
        className={cn(
          "flex h-8 w-full items-center gap-2.5 rounded-[7px] pr-2 pl-2.5 text-left text-sm transition-colors",
          "hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        )}
      >
        {icon}
        <span
          className={cn(
            "truncate",
            folded.unreadDot
              ? "font-semibold text-sidebar-foreground"
              : "font-normal text-sidebar-foreground/80",
          )}
        >
          {label}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* An empty list folds to nothing: a "0" says nothing useful. */}
          {folded.count ? (
            <span
              data-testid="nav-disclosure-count"
              className="font-mono text-2xs font-medium text-muted-foreground"
            >
              {folded.count}
            </span>
          ) : null}
          {folded.unreadDot ? (
            <span
              data-testid="nav-disclosure-unread"
              className="size-2 shrink-0 rounded-full bg-sidebar-active"
            >
              <span className="sr-only">Unread</span>
            </span>
          ) : null}
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-sidebar-foreground/50 transition-transform duration-150",
              !collapsed && "rotate-90",
            )}
          />
        </span>
      </button>
      {children}
      {!collapsed && (
        <ul
          id={listId}
          aria-label={label}
          // The guide line sits under the parent's glyph (row pl-2.5 + half
          // of the size-4 glyph), so the rows read as belonging to it.
          className="ml-[17px] flex flex-col gap-px border-l border-line-2 pl-1.5"
        >
          {list.shown.map((item) => (
            <li key={getKey(item)}>{renderItem(item)}</li>
          ))}
          {list.hasMoreRow && (
            <li>
              <button
                type="button"
                data-testid="nav-disclosure-more"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
                className="flex h-7.5 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-sidebar-meta text-sidebar-foreground/60 transition-colors hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground"
              >
                <MoreHorizontal aria-hidden className="size-3.75 shrink-0" />
                <span>{list.moreLabel}</span>
              </button>
            </li>
          )}
          {footer ? <li>{footer}</li> : null}
        </ul>
      )}
    </div>
  );
}
