/**
 * Pure list logic for the sidebar's collapsible sections (left-nav redesign,
 * 2026-09-28): truncation with an "N more" row, the selected row always
 * staying visible, and what a collapsed header shows. Row ORDER for
 * Favorites and Channels lives in sectionOrder.ts (unread, then most used).
 *
 * The tunable lives here and only here, so the sidebar and its tests read
 * the same value.
 */

/** Sidebar list settings (the design's `visibleItems`). */
export interface SidebarListOptions {
  /** Rows an open section shows before the "N more" row. */
  visibleItems: number;
}

export const SIDEBAR_LIST_OPTIONS: SidebarListOptions = {
  visibleItems: 6,
};

/** What an open section renders. */
export interface TruncatedSection<T> {
  /** Rows to render, in order. */
  shown: T[];
  /** Rows not rendered (the "N" in "N more"). */
  hiddenCount: number;
  /** Render the more/less toggle row. */
  hasMoreRow: boolean;
  /** "N more" while truncated, "Show less" while expanded. */
  moreLabel: string;
}

/**
 * Truncate an open section to `limit` rows.
 *
 * - A list at most ONE over the limit is shown whole: a "1 more" row would
 *   take the same space as the row it hides.
 * - The selected row always stays visible: if it falls past the cutoff it is
 *   appended after the first `limit` rows.
 * - `expanded` (the user clicked "N more") shows everything with a
 *   "Show less" row.
 */
export function truncateSection<T>({
  items,
  limit,
  expanded,
  isSelected,
}: {
  items: readonly T[];
  limit: number;
  expanded: boolean;
  isSelected?: (item: T) => boolean;
}): TruncatedSection<T> {
  if (items.length <= limit + 1) {
    return {
      shown: [...items],
      hiddenCount: 0,
      hasMoreRow: false,
      moreLabel: "",
    };
  }
  if (expanded) {
    return {
      shown: [...items],
      hiddenCount: 0,
      hasMoreRow: true,
      moreLabel: "Show less",
    };
  }
  const shown = items.slice(0, limit);
  const selected = isSelected ? items.find(isSelected) : undefined;
  if (selected !== undefined && !shown.includes(selected)) {
    shown.push(selected);
  }
  const hiddenCount = items.length - shown.length;
  return {
    shown,
    hiddenCount,
    hasMoreRow: hiddenCount > 0,
    moreLabel: `${hiddenCount} more`,
  };
}

/** What a section header shows beside its label. */
export interface SectionHeaderState {
  /** Item count, shown only while collapsed. */
  count: number | null;
  /** Accent dot: collapsed and something inside is unread. */
  unreadDot: boolean;
}

export function sectionHeaderState<T>({
  items,
  collapsed,
  isUnread,
}: {
  items: readonly T[];
  collapsed: boolean;
  isUnread?: (item: T) => boolean;
}): SectionHeaderState {
  if (!collapsed) return { count: null, unreadDot: false };
  return {
    count: items.length,
    unreadDot: isUnread ? items.some(isUnread) : false,
  };
}
