import { useAsks } from "@/features/home/AsksProvider";
import { useItemCounts } from "@/features/items/ItemsProvider";
import { useWorkCounts } from "@/features/work/useWorkCounts.ts";

import { ChannelSidebar, type ChannelSidebarProps } from "./ChannelSidebar";

/**
 * The sidebar with its live counts filled in: unanswered asks from the
 * shell-level AsksProvider context (Inbox row), the Work feed's needs-you
 * count (the Work row, shown below lg where there is no Work rail), and open
 * bugs · backlog from ItemsProvider (Items row). The sidebar itself stays
 * context-free — every other input arrives by prop.
 *
 * Must render inside AsksProvider, WorkProvider and ItemsProvider.
 */
export function SidebarWithBadges(
  props: Omit<
    ChannelSidebarProps,
    "asksCount" | "needsCount" | "channelMarkers" | "itemCounts"
  >,
) {
  const { badge } = useAsks();
  const { needs, markers } = useWorkCounts();
  const itemCounts = useItemCounts();
  return (
    <ChannelSidebar
      {...props}
      asksCount={badge}
      needsCount={needs}
      channelMarkers={markers}
      itemCounts={itemCounts}
    />
  );
}
