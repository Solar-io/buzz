import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  SIDEBAR_LIST_OPTIONS,
  sectionHeaderState,
  truncateSection,
} from "@/features/sidebar/lib/sectionList.ts";
import { SectionHeader } from "@/features/sidebar/ui/SectionHeader";

/** Props for {@link SidebarSection}. */
export interface SidebarSectionProps<T> {
  label: string;
  /** Already ordered (unread-first sorting is the caller's choice). */
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  isSelected?: (item: T) => boolean;
  isUnread?: (item: T) => boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onAdd?: () => void;
  addLabel?: string;
  /** A quiet mono hint at the header's right end. */
  hint?: string;
  /** Rendered between the header and the rows (create dialogs, empty copy). */
  children?: ReactNode;
  /** Rows before the "N more" row; defaults to SIDEBAR_LIST_OPTIONS. */
  visibleItems?: number;
}

/**
 * One collapsible sidebar section: header, the truncated rows, and the
 * "N more" / "Show less" toggle row. The show-all state is per mount (not
 * persisted) — it is a momentary peek, unlike the collapse.
 */
export function SidebarSection<T>({
  label,
  items,
  getKey,
  renderItem,
  isSelected,
  isUnread,
  collapsed,
  onToggleCollapsed,
  onAdd,
  addLabel,
  hint,
  children,
  visibleItems = SIDEBAR_LIST_OPTIONS.visibleItems,
}: SidebarSectionProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const header = sectionHeaderState({ items, collapsed, isUnread });
  const list = truncateSection({
    items,
    limit: visibleItems,
    expanded,
    isSelected,
    isUnread,
  });
  return (
    <section className="flex flex-col gap-px" aria-label={label}>
      <SectionHeader
        label={label}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        count={header.count}
        unreadDot={header.unreadDot}
        onAdd={onAdd}
        addLabel={addLabel}
        hint={hint}
      />
      {children}
      {!collapsed && list.shown.length > 0 && (
        <ul className="flex flex-col gap-px">
          {list.shown.map((item) => (
            <li key={getKey(item)}>{renderItem(item)}</li>
          ))}
          {list.hasMoreRow && (
            <li>
              <button
                type="button"
                data-testid="section-more"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="flex h-7.5 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-sidebar-meta text-sidebar-foreground/60 transition-colors hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground"
              >
                <MoreHorizontal aria-hidden className="size-3.75 shrink-0" />
                <span>{list.moreLabel}</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
