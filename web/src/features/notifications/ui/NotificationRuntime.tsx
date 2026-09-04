import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useNotificationRuntime } from "../hooks";

export interface NotificationRuntimeProps {
  /** The signed-in key; the runtime is inert until it resolves. */
  selfPubkey: string | null;
  /** The shell's channel list — see the hook for why it is not fetched here. */
  channels: ChannelSummary[];
}

/**
 * The notification runtime, mounted as an invisible component.
 *
 * It renders nothing — it exists so the subscription, the OS notification and
 * the tab-title badge have a React lifetime to live in. It reads the open
 * channel from the router rather than taking it as a prop, so it can be
 * mounted anywhere inside the app shell without new wiring.
 *
 * Mounted from the shell (`app/routes/repos.tsx`) so it survives every route
 * the signed-in app can be on — mounted in the sidebar it would die wherever
 * the sidebar unmounts.
 */
export function NotificationRuntime({
  selfPubkey,
  channels,
}: NotificationRuntimeProps) {
  const navigate = useNavigate();
  const activeChannelId = useRouterState({
    select: (state) => {
      const search = state.location.search as { c?: unknown };
      return typeof search?.c === "string" ? search.c : null;
    },
  });

  useNotificationRuntime({
    selfPubkey,
    channels,
    activeChannelId,
    onOpenChannel: (channelId) => {
      void navigate({ to: "/repos", search: { c: channelId } });
    },
  });

  return null;
}
