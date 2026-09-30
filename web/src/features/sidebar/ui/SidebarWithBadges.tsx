import { useAsks } from "@/features/home/AsksProvider";
import { useWorkCounts } from "@/features/work/useWorkCounts.ts";

import { ChannelSidebar, type ChannelSidebarProps } from "./ChannelSidebar";

/**
 * The sidebar with its two live count badges filled in: unanswered asks from
 * the shell-level AsksProvider context (Inbox row) and the Work feed's
 * needs-you count (the Work row, shown below lg where there is no Work
 * rail). The sidebar itself stays context-free — every other input arrives
 * by prop.
 *
 * Must render inside AsksProvider and WorkProvider.
 */
export function SidebarWithBadges(
  props: Omit<ChannelSidebarProps, "asksCount" | "needsCount">,
) {
  const { badge } = useAsks();
  const { needs } = useWorkCounts();
  return <ChannelSidebar {...props} asksCount={badge} needsCount={needs} />;
}
