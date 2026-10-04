import { BellOff } from "lucide-react";
import type { ReactNode } from "react";
import type { SidebarMenuItem } from "@/features/sidebar/lib/sidebarMenuItem";
import { formatUnreadCount } from "@/features/channels/lib/channelActivity.ts";
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
import { StateHex } from "@/shared/ui/HexAvatar";

/** Props for {@link SidebarNavButton}. */
export interface SidebarNavButtonProps {
  selected: boolean;
  label: string;
  /** Leading glyph — channels pass the desktop's Hash mark. */
  icon?: ReactNode;
  /** Unread — newest activity newer than the read marker. */
  unread?: boolean;
  /**
   * Live unread message count for the row. 1+ renders the count badge
   * (DmNavRow's badge, for one visual language across the sidebar); null or
   * 0 keeps the metadata-fallback dot — the unread signal without a counted
   * window yet, or a metadata-only change the count cannot express. Muted
   * rows render neither (the caller's unread already folds mute in).
   */
  unreadCount?: number | null;
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
  /**
   * What the channel's agents are doing (web redesign Phase 2; Main
   * artboard): a coral hex and a count when something here needs the viewer,
   * else a pulsing amber hex — with a count past one — while agents work.
   */
  status?: { needs: number; running: number } | null;
  /**
   * Quiet trailing text for a destination row — Items' "11 · 31" (open bugs
   * · open backlog). Not a badge: nothing here is unread.
   */
  meta?: ReactNode;
}

/** The row's work marker, or nothing. Needs outrank running. */
export function StatusMarker({
  status,
}: {
  status: { needs: number; running: number };
}) {
  if (status.needs > 0) {
    return (
      <span
        data-testid="sidebar-row-needs"
        title={`${status.needs} ${status.needs === 1 ? "needs" : "need"} you`}
        className="inline-flex shrink-0 items-center gap-1 font-mono text-badge font-semibold text-coral-ink"
      >
        <StateHex tone="need" size={8} />
        {status.needs}
      </span>
    );
  }
  if (status.running > 0) {
    return (
      <span
        data-testid="sidebar-row-running"
        title={`${status.running} ${status.running === 1 ? "agent" : "agents"} working`}
        className="inline-flex shrink-0 items-center gap-1 font-mono text-badge font-semibold text-honey-ink"
      >
        <StateHex tone="work" size={8} pulse />
        {status.running > 1 ? status.running : null}
      </span>
    );
  }
  return null;
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
  unreadCount,
  muted,
  onSelect,
  menuItems,
  status,
  meta,
}: SidebarNavButtonProps) {
  const marked = status != null && (status.needs > 0 || status.running > 0);
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
        "group/row flex h-8 w-full items-center gap-2.5 truncate rounded-[7px] pr-2 pl-2.5 text-left text-sm transition-colors",
        "hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
        // `buzz-sidebar-active-row` paints the token-driven selection surface
        // and color — quiet gray by default, solid mauve under the Prominent
        // active tab preference (shared/styles/globals.css).
        selected && "buzz-sidebar-active-row",
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
            ? "buzz-sidebar-active-label"
            : unread
              ? "font-semibold text-sidebar-foreground"
              : "font-normal text-sidebar-foreground/80",
        )}
      >
        {label}
      </span>
      {marked && status ? (
        <span className="ml-auto flex shrink-0 items-center">
          <StatusMarker status={status} />
        </span>
      ) : null}
      {meta != null && !marked ? (
        <span className="ml-auto shrink-0 font-mono text-2xs font-medium text-muted-foreground">
          {meta}
        </span>
      ) : null}
      {muted && (
        <BellOff
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            !unread && !marked && "ml-auto",
          )}
          aria-label="Muted"
        />
      )}
      {unread && unreadCount != null && unreadCount >= 1 ? (
        // Count badge — DmNavRow's badge classes verbatim (20px pill,
        // bg-sidebar-active, tabular nums) so channels and DMs read as one
        // design; the dot below remains the fallback while no count exists.
        <span
          className={cn(
            "flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-sidebar-active px-[5px] text-2xs font-semibold leading-none tabular-nums text-sidebar-active-foreground",
            !muted && !marked && "ml-auto",
          )}
        >
          {formatUnreadCount(unreadCount)}
        </span>
      ) : (
        unread && (
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full bg-sidebar-active",
              !muted && !marked && "ml-auto",
            )}
          />
        )
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
                // Opacity, not display: while the menu is open Radix sets
                // pointer-events on the rest of the page, the row loses
                // :hover, and a `hidden` trigger collapses to a zero rect —
                // the popper then re-anchors at (0,0) and the menu teleports
                // to the top-left of the window (Sam, 2026-09-22). Staying
                // in layout keeps the anchor rect real. pointer-events
                // follow the reveal so the invisible trigger is not a click
                // trap; focus keeps it visible for the keyboard path.
                "shrink-0 rounded p-0.5 text-xs text-sidebar-foreground/60 hover:bg-sidebar-foreground/10",
                "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
                "focus-visible:pointer-events-auto focus-visible:opacity-100",
                !unread && !muted && !marked && "ml-auto",
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
