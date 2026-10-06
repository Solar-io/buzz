import { markSeen } from "@/features/activity/readMarkers.ts";
import type { DmSummary } from "@/features/dms/hooks";
import { favoriteMenuItem } from "./favoriteMenuItem.ts";
import type { SidebarMenuItem } from "./sidebarMenuItem";

/**
 * A DM row's right-click / ⋯ menu: favorite, mark read, remove from list.
 *
 * "Mark read" marks up to the newest message the activity store has seen
 * (not the 39000 time, which messages never bump), through the read-marker
 * store — traced as `menu` and published to the other devices over NIP-RS,
 * exactly like a channel row's "Mark read" (QA #19: DM rows had none).
 */
export function dmMenuItems(
  dm: DmSummary,
  deps: {
    favorite: boolean;
    newestActivityAt: number | undefined;
    onToggleFavorite: () => void;
    onHide: () => void;
  },
): SidebarMenuItem[] {
  const { channel } = dm;
  return [
    favoriteMenuItem(deps.favorite, deps.onToggleFavorite),
    {
      label: "Mark read",
      onSelect: () => {
        markSeen(
          channel.id,
          Math.max(
            channel.updatedAt,
            dm.lastMessage?.created_at ?? 0,
            deps.newestActivityAt ?? 0,
          ),
          "menu",
        );
      },
    },
    { label: "Remove from list", danger: true, onSelect: deps.onHide },
  ];
}
