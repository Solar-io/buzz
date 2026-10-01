import { useAsks } from "@/features/home/AsksProvider";
import { useItemCounts } from "@/features/items/ItemsProvider";
import { useShelfNewCount } from "@/features/shelf/ShelfProvider";
import { useWorkCounts } from "@/features/work/useWorkCounts.ts";

import { ChannelSidebar, type ChannelSidebarProps } from "./ChannelSidebar";

/**
 * The sidebar with its live counts filled in: unanswered asks from the
 * shell-level AsksProvider context (Inbox row), the Work feed's needs-you
 * count (the Work row, shown below lg where there is no Work rail), open
 * bugs · backlog from ItemsProvider (Items row), and files shared since the
 * Shelf was last opened (Shelf row). The sidebar itself stays context-free —
 * every other input arrives by prop.
 *
 * Must render inside AsksProvider, WorkProvider, ItemsProvider and
 * ShelfProvider.
 */
export function SidebarWithBadges(
  props: Omit<
    ChannelSidebarProps,
    "asksCount" | "needsCount" | "channelMarkers" | "itemCounts" | "shelfNew"
  >,
) {
  const { badge } = useAsks();
  const { needs, markers } = useWorkCounts();
  const itemCounts = useItemCounts();
  const shelfNew = useShelfNewCount();
  return (
    <ChannelSidebar
      {...props}
      asksCount={badge}
      needsCount={needs}
      channelMarkers={markers}
      itemCounts={itemCounts}
      shelfNew={shelfNew}
    />
  );
}
