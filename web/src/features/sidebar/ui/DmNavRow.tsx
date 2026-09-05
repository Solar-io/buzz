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
  const row = (
    <button
      type="button"
      data-active={selected ? "true" : "false"}
      className={cn(
        // dm-list-spec.md §3: 32px rows, 8px-radius highlight inset 6px,
        // 24px avatar at 14px (8px inside the highlight), 8px avatar→label
        // gap, 4px badge inset on the right.
        "flex h-8 w-full items-center gap-2 rounded-[8px] pl-2 pr-1 text-left transition-colors",
        "hover:bg-white/5",
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
          />
        )}
        {/* Presence dot at the avatar's 45° bottom-right, ringed in the page
            background (cut-out), 1:1 rows only.
            Sized 10px, not the dm-list spec's 6px. The ring is a cut-out on
            every side, so a 6px dot with a 1.5px ring left roughly 3px of
            actual colour — reported as "so tiny it is barely viewable", and
            the agent-live indicator is the one people look for. 10px with a
            2px ring leaves 6px of colour: double, and still a dot. */}
        {others.length <= 1 && presence && (
          <span
            title={presence.status}
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-sidebar",
              presenceDotClass(presence.status),
            )}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          // Read / unread / selected, from the sidebar tokens rather than
          // the sampled literals they were pinned to.
          selected
            ? "buzz-sidebar-active-label text-black"
            : unread
              ? "font-semibold text-sidebar-foreground"
              : "font-normal text-sidebar-foreground/70",
        )}
      >
        {name}
      </span>
      {(active || unread) && (
        <span className="flex shrink-0 items-center gap-2">
          {active && (
            <DmTimerPill
              startedAt={
                agentTurnStart(rowFrames) ?? rowFrames[0]?.createdAt ?? now
              }
              now={now}
              selected={selected}
            />
          )}
          {/* §7: 20px badge; the reference shows badge and pill together —
              an unread row keeps its badge even while the agent works.
              §6: the pill's right edge stays fixed whether or not a badge
              is present — the 20px slot always reserves it. */}
          {unread ? (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-sidebar-active px-1 text-2xs font-semibold leading-none tabular-nums text-sidebar-active-foreground">
              {unreadCount != null && unreadCount > 0
                ? unreadCount > 99
                  ? "99+"
                  : unreadCount
                : ""}
            </span>
          ) : (
            <span className="size-5 shrink-0" aria-hidden />
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
