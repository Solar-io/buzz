import { useAgentFrames } from "@/features/agents/ObserverProvider";
import {
  agentRecentlyActive,
  agentTurnStart,
} from "@/features/agents/lib/observerEvents";
import { useTick } from "@/features/agents/ui/WorkingBadge";
import type { Profile } from "@/features/channels/hooks";
import {
  presenceDotClass,
  type PresenceEntry,
} from "@/features/channels/lib/presence.ts";
import { AuthorAvatar } from "@/features/channels/ui/ChannelTimeline";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { focusToken } from "@/features/user-status/lib/focusLine.ts";
import type { UserStatus } from "@/features/user-status/lib/statusEvent.ts";
import { useUnreadCount } from "@/features/sidebar/lib/useUnreadCount.ts";
import { DmTimerPill } from "@/features/sidebar/ui/DmTimerPill";
import { GroupAvatar } from "@/features/sidebar/ui/GroupAvatar";
import { useDrawerClose } from "@/shared/layout/AppShell";
import type { SidebarMenuItem } from "@/features/sidebar/lib/sidebarMenuItem";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { cn } from "@/shared/lib/cn";

/** Props for {@link DmNavRow}. */
export interface DmNavRowProps {
  selected: boolean;
  unread: boolean;
  channelId: string | null;
  /** Read marker (unix seconds) for the unread count, when known. */
  lastSeenAt: number | null;
  participants: string[];
  selfPubkey: string | null;
  profiles: Map<string, Profile>;
  /**
   * kind-30315 focus status for the row's avatar pubkey, from the sidebar's
   * ONE bulk fetch (ChannelSidebar). null/undefined = nothing current; the
   * row then renders exactly as before — most rows until the fleet
   * convention fans out.
   */
  status?: UserStatus | null;
  /** Latest presence entry for the row's avatar pubkey, when subscribed. */
  presence?: PresenceEntry;
  onSelect: () => void;
  /** Right-click menu items (remove from list), when provided. */
  menuItems?: SidebarMenuItem[];
}

/**
 * DM sidebar row in the desktop client's shape: avatar, display name, and a
 * one-line preview of the newest sampled message with its stamp.
 */
export function DmNavRow({
  selected,
  unread,
  channelId,
  lastSeenAt,
  participants,
  selfPubkey,
  profiles,
  status,
  presence,
  onSelect,
  menuItems,
}: DmNavRowProps) {
  const closeDrawer = useDrawerClose();
  const others = participants.filter(
    (pubkey, index) =>
      pubkey !== selfPubkey && participants.indexOf(pubkey) === index,
  );
  const avatarPubkey = others[0] ?? participants[0] ?? "";
  const avatarLabel = profiles.get(avatarPubkey)?.displayName ?? avatarPubkey;
  const name = dmDisplayName(participants, selfPubkey ?? "", profiles);
  // Per-agent working pulse in the sidebar: the store's freshness view of
  // THIS row's agent (multi-agent aware — several rows can pulse at once).
  const rowFrames = useAgentFrames(avatarPubkey || null);
  const now = Math.floor(Date.now() / 1000);
  const active = agentRecentlyActive(rowFrames, now);
  useTick(active);
  const unreadCount = useUnreadCount(channelId, lastSeenAt, selfPubkey);
  // Focus token from the same module the roster uses — text only, no emoji,
  // no age (this row already carries its own times on the right; Sam,
  // 2026-09-06). One staleness implementation for both surfaces. `now` is
  // the row's existing per-render clock read (the statuses hook's 30s tick
  // re-renders the section, and useTick refreshes working rows every
  // second); null renders NOTHING below — the empty state is the common
  // case and stays pixel-identical to before.
  const focus = focusToken(status, now);
  const row = (
    <button
      type="button"
      data-active={selected ? "true" : "false"}
      className={cn(
        // Left-nav redesign (2026-09-28): the nav-row recipe — 32px, 7px
        // radius, 10px gap, padding 0 8px 0 10px — with a 22px avatar in the
        // icon slot.
        "flex h-8 w-full items-center gap-2.5 rounded-[7px] pr-2 pl-2.5 text-left transition-colors",
        "hover:bg-sidebar-foreground/5",
        // §5: flat solid accent fill, no ring, contrasting label. The class
        // resolves to that same fill unless the Prominent active tab
        // preference is on (shared/styles/globals.css).
        selected && "buzz-sidebar-active-row",
      )}
      onClick={() => {
        onSelect();
        closeDrawer();
      }}
    >
      <span className="relative shrink-0">
        {others.length > 1 ? (
          <GroupAvatar count={others.length} dm />
        ) : (
          <AuthorAvatar
            pubkey={avatarPubkey}
            label={avatarLabel}
            picture={profiles.get(avatarPubkey)?.avatar}
            size="dm"
            // 22px rounded square (6px radius) per the left-nav redesign.
            className="size-5.5 rounded-[6px]"
          />
        )}
        {/* Presence dot at the avatar's bottom-right, ringed in the sidebar
            ground (cut-out), 1:1 rows only. Left-nav redesign: 9px with a
            2px ring, sized to the 22px square avatar. */}
        {others.length <= 1 && presence && (
          <span
            title={presence.status}
            className={cn(
              "absolute -bottom-[2px] -right-[2px] size-2.25 rounded-full border-2 border-sidebar",
              presenceDotClass(presence.status),
            )}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <span
          className={cn(
            "max-w-full flex-none truncate text-sm",
            // Read / unread / selected, from the sidebar tokens rather than
            // the sampled literals they were pinned to.
            selected
              ? "buzz-sidebar-active-label"
              : unread
                ? "font-semibold text-sidebar-foreground"
                : "font-normal text-sidebar-foreground/80",
          )}
        >
          {name}
        </span>
        {/* Status snippet (focus token): grey 12px, and the part of the row
            that truncates — the name keeps its width, and the time / badge
            are shrink-0 siblings, so a narrow row clips only this snippet.
            Text-only: no emoji, no age. */}
        {focus !== null && (
          <span
            data-testid="dm-row-status"
            title="Current project focus (self-reported status)"
            className={cn(
              "min-w-0 truncate text-xs font-normal",
              // Selected rows: INHERIT the active row's color (set by
              // .buzz-sidebar-active-row from the theme tokens) and mute with
              // opacity — correct on both surfaces the preference can produce
              // (default dark fill, prominent solid accent) with no hardcoded
              // literal. The previous text-black/60 assumed the prominent
              // light fill and rendered black-on-black on the default dark
              // one (Sam, 2026-09-07).
              selected ? "opacity-60" : "text-sidebar-foreground/50",
            )}
          >
            {focus}
          </span>
        )}
      </span>
      {(active || unread) && (
        <span className="flex shrink-0 items-center gap-2.5">
          {active && (
            <DmTimerPill
              startedAt={
                agentTurnStart(rowFrames) ?? rowFrames[0]?.createdAt ?? now
              }
              now={now}
              selected={selected}
            />
          )}
          {/* 18px accent pill; an unread row keeps its badge even while the
              agent works. No reserved slot when read — the time sits flush
              right, as in the redesign. */}
          {unread && (
            <span
              data-testid="dm-row-badge"
              className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-sidebar-active px-[5px] text-2xs font-semibold leading-none tabular-nums text-sidebar-active-foreground"
            >
              {unreadCount != null && unreadCount > 0
                ? unreadCount > 99
                  ? "99+"
                  : unreadCount
                : ""}
            </span>
          )}
        </span>
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
