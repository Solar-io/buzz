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
      className={cn(
        // dm-list-spec.md §3: 32px rows, 8px-radius highlight inset 6px,
        // 24px avatar at 14px (8px inside the highlight), 8px avatar→label
        // gap, 4px badge inset on the right.
        "flex h-8 w-full items-center gap-2 rounded-[8px] pl-2 pr-1 text-left transition-colors",
        "hover:bg-white/5",
        // §5: flat solid #9A3EF6 fill, no ring, black label.
        selected && "bg-[#9A3EF6]",
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
        {/* §8: 6px presence dot at the avatar's 45° bottom-right, ringed in
            the page background (cut-out), 1:1 rows only. */}
        {others.length <= 1 && presence && (
          <span
            title={presence.status}
            className={cn(
              "absolute -bottom-px -right-px size-1.5 rounded-full border-[1.5px] border-sidebar",
              presenceDotClass(presence.status),
            )}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          // B-target palette (dm-list-diff.md Defect 2): read #A0A8C7,
          // unread #C4CFF2, selected #000000.
          selected
            ? "font-normal text-black"
            : unread
              ? "font-semibold text-[#C4CFF2]"
              : "font-normal text-[#A0A8C7]",
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
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#9A3EF6] px-1 text-[11px] font-semibold leading-none tabular-nums text-black">
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
