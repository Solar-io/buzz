import { BellOff } from "lucide-react";
import type { ReactNode } from "react";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";
import { useDrawerClose } from "@/shared/layout/AppShell";
import { cn } from "@/shared/lib/cn";

/** Props for {@link SidebarNavButton}. */
export interface SidebarNavButtonProps {
  selected: boolean;
  label: string;
  /** Leading glyph — channels pass the desktop's Hash mark. */
  icon?: ReactNode;
  /** Unread dot — newest activity newer than the read marker. */
  unread?: boolean;
  /**
   * Muted rows dim and carry a bell-off glyph, matching the desktop.
   * Mute already suppresses the unread dot; without this the row looked
   * identical to a read one, so there was no way to tell a muted channel
   * from a quiet one.
   */
  muted?: boolean;
  onSelect: () => void;
  /** Right-click / ⋯ context menu items, when provided. */
  menuItems?: ContextMenuItem[];
}

/**
 * Sidebar navigation entry, styled to Buzz Dark: hover = white/4 wash, the
 * active row = the desktop's translucent white/18 pill (theme.css
 * --sidebar-row-active-surface), no accent color.
 * Calls useDrawerClose after selecting so the phone drawer dismisses.
 */
export function SidebarNavButton({
  selected,
  label,
  icon,
  unread,
  muted,
  onSelect,
  menuItems,
}: SidebarNavButtonProps) {
  const closeDrawer = useDrawerClose();
  const row = (open: (x: number, y: number) => void) => (
    <button
      type="button"
      className={cn(
        // Same desktop row recipe as the DM list (SidebarMenuButton h-8
        // text-sm): the sections read as one surface.
        "group/row flex h-8 w-full items-center gap-2 truncate rounded-[8px] px-2 text-left text-sm transition-colors",
        "hover:bg-white/5 hover:text-foreground",
        selected && "bg-[#9A3EF6] font-normal text-black",
        // Desktop dims muted rows rather than hiding them.
        muted && !selected && "opacity-50",
      )}
      onClick={() => {
        onSelect();
        closeDrawer();
      }}
      onContextMenu={
        menuItems
          ? (event) => {
              event.preventDefault();
              open(event.clientX, event.clientY);
            }
          : undefined
      }
    >
      {icon}
      <span
        className={cn(
          "truncate",
          selected
            ? "text-black"
            : unread
              ? "font-semibold text-[#C4CFF2]"
              : "font-normal text-[#A0A8C7]",
        )}
      >
        {label}
      </span>
      {muted && (
        <BellOff
          className={cn("h-3.5 w-3.5 shrink-0", !unread && "ml-auto")}
          aria-label="Muted"
        />
      )}
      {unread && (
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full bg-[#9A3EF6]",
            !muted && "ml-auto",
          )}
        />
      )}
      {menuItems && (
        // A real <button> cannot nest inside the row button — the span keeps
        // keyboard access via tabIndex + onKeyDown below.
        // biome-ignore lint/a11y/useSemanticElements: nested interactive elements cannot both be buttons
        <span
          role="button"
          tabIndex={0}
          aria-label={`Options for ${label}`}
          className={cn(
            "hidden shrink-0 rounded p-0.5 text-xs text-sidebar-foreground/60 hover:bg-white/10 group-hover/row:block",
            !unread && !muted && "ml-auto",
          )}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            open(rect.left, rect.bottom + 4);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              open(rect.left, rect.bottom + 4);
            }
          }}
        >
          ⋯
        </span>
      )}
    </button>
  );
  if (menuItems) {
    return <ContextMenu items={menuItems}>{row}</ContextMenu>;
  }
  return row(() => {});
}
