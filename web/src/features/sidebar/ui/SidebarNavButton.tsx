import { BellOff } from "lucide-react";
import type { ReactNode } from "react";
import type { SidebarMenuItem } from "@/features/sidebar/lib/sidebarMenuItem";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
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
  /** Right-click / ⋯ menu items, when provided. */
  menuItems?: SidebarMenuItem[];
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
  const row = (
    <button
      type="button"
      // The active row is the one thing the Prominent active tab preference
      // repaints, so it has to be findable — by CSS, and by a test that has to
      // prove the preference actually moved a pixel.
      data-active={selected ? "true" : "false"}
      className={cn(
        // Same desktop row recipe as the DM list (SidebarMenuButton h-8
        // text-sm): the sections read as one surface.
        "group/row flex h-8 w-full items-center gap-2 truncate rounded-[8px] px-2 text-left text-sm transition-colors",
        "hover:bg-white/5 hover:text-foreground",
        // `buzz-sidebar-active-row` resolves to exactly what
        // `bg-sidebar-active` painted before, unless the Prominent active tab
        // preference is on (shared/styles/globals.css).
        selected && "buzz-sidebar-active-row text-sidebar-active-foreground",
        // Desktop dims muted rows rather than hiding them.
        muted && !selected && "opacity-50",
      )}
      onClick={() => {
        onSelect();
        closeDrawer();
      }}
    >
      {icon}
      <span
        className={cn(
          "truncate",
          selected
            ? "buzz-sidebar-active-label text-sidebar-active-foreground"
            : unread
              ? "font-semibold text-sidebar-foreground"
              : "font-normal text-sidebar-foreground/70",
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
            "h-2 w-2 shrink-0 rounded-full bg-sidebar-active",
            !muted && "ml-auto",
          )}
        />
      )}
      {menuItems && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* A real <button> cannot nest inside the row button; the span is
                the trigger and Radix gives it keyboard handling. */}
            {/* biome-ignore lint/a11y/useSemanticElements: nested interactive elements cannot both be buttons */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: DropdownMenuTrigger asChild supplies onKeyDown — verified in the installed @radix-ui/react-dropdown-menu, which composes Enter / Space / ArrowDown onto this child */}
            <span
              role="button"
              tabIndex={0}
              aria-label={`Options for ${label}`}
              className={cn(
                "hidden shrink-0 rounded p-0.5 text-xs text-sidebar-foreground/60 hover:bg-white/10 group-hover/row:block",
                !unread && !muted && "ml-auto",
              )}
              onClick={(event) => event.stopPropagation()}
            >
              ⋯
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {menuItems.map((item) => (
              <DropdownMenuItem
                key={item.label}
                onSelect={item.onSelect}
                className={
                  item.danger
                    ? "text-destructive focus:text-destructive"
                    : undefined
                }
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </button>
  );
  if (!menuItems) {
    return row;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems.map((item) => (
          <ContextMenuItem
            key={item.label}
            onSelect={item.onSelect}
            className={
              item.danger
                ? "text-destructive focus:text-destructive"
                : undefined
            }
          >
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
