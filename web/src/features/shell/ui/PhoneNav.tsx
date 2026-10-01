import { Bell, Bot, Folder, Inbox, ListPlus, Settings } from "lucide-react";
import { useEffect } from "react";

import { useWorkCounts } from "@/features/work/useWorkCounts.ts";
import { PhoneTabBar } from "@/shared/layout/PhoneTabBar";
import {
  activePhoneTab,
  rememberPhoneTab,
  viewOwnsPhoneScreen,
} from "@/shared/layout/phoneTabs.ts";
import { isNativeIOS } from "@/shared/platform/native";
import { StateHex } from "@/shared/ui/HexAvatar";

/**
 * The phone tab bar, wired to the shell (phase-1 §6): Work carries the
 * needs-you count, Channels the unread-conversation count, and More lists
 * the views that exist today. The tab is derived from `?view=`; visiting a
 * tab remembers it as the conversation back-chevron's target.
 */
export function PhoneNav({
  view,
  unread,
  onOpenView,
  onOpenFiles,
  onOpenSettings,
  onOpenAgents,
}: {
  view: string | undefined;
  unread: number;
  onOpenView: (
    view: "work" | "channels" | "inbox" | "items" | "reminders",
  ) => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
  onOpenAgents: () => void;
}) {
  const { needs } = useWorkCounts();
  const active = activePhoneTab(view);
  useEffect(() => rememberPhoneTab(active), [active]);
  if (viewOwnsPhoneScreen(view)) {
    return null;
  }
  const icon = "size-5";
  return (
    <PhoneTabBar
      active={active}
      needs={needs}
      unread={unread}
      onWork={() => onOpenView("work")}
      onChannels={() => onOpenView("channels")}
      more={[
        {
          label: "Inbox",
          icon: <Inbox aria-hidden className={icon} />,
          onSelect: () => onOpenView("inbox"),
        },
        {
          label: "Items",
          icon: <ListPlus aria-hidden className={icon} />,
          onSelect: () => onOpenView("items"),
        },
        {
          label: "Reminders",
          icon: <Bell aria-hidden className={icon} />,
          onSelect: () => onOpenView("reminders"),
        },
        {
          label: "Files",
          icon: <Folder aria-hidden className={icon} />,
          onSelect: onOpenFiles,
        },
        {
          label: "Settings",
          icon: <Settings aria-hidden className={icon} />,
          onSelect: onOpenSettings,
        },
        ...(isNativeIOS()
          ? []
          : [
              {
                label: "Agents",
                icon: <Bot aria-hidden className={icon} />,
                onSelect: onOpenAgents,
              },
            ]),
      ]}
    />
  );
}

/**
 * The conversation top bar's way back to Work (PhoneChannel artboard): the
 * coral hex and the needs-you count. Renders nothing at zero — a pill that
 * says "0" is a control with nothing behind it.
 */
export function PhoneWorkPill({ onOpen }: { onOpen: () => void }) {
  const { needs } = useWorkCounts();
  if (needs <= 0) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label={`Work, ${needs} need you`}
      onClick={onOpen}
      className="ml-1 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-border bg-card px-3 text-sidebar-meta font-semibold"
    >
      <StateHex tone="need" size={10} />
      {needs}
    </button>
  );
}
