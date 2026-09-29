import { useAsks } from "@/features/home/AsksProvider";
import { useDueReminderCount } from "@/features/reminders/hooks";

import { ChannelSidebar, type ChannelSidebarProps } from "./ChannelSidebar";

/**
 * The sidebar with its two live count badges filled in: unanswered asks from
 * the shell-level AsksProvider context (Inbox row) and due reminders from the
 * shared reminders query (Reminders row). The sidebar itself stays
 * context-free — every other input arrives by prop.
 *
 * Must render inside AsksProvider.
 */
export function SidebarWithBadges(
  props: Omit<ChannelSidebarProps, "asksCount" | "remindersCount">,
) {
  const { badge } = useAsks();
  const dueReminders = useDueReminderCount(props.dmIdentity.selfPubkey);
  return (
    <ChannelSidebar
      {...props}
      asksCount={badge}
      remindersCount={dueReminders}
    />
  );
}
