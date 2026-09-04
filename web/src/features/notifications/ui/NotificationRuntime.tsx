import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useNotificationRuntime } from "../hooks";

export interface NotificationRuntimeProps {
  /** The signed-in key; the runtime is inert until it resolves. */
  selfPubkey: string | null;
}

/**
 * The notification runtime, mounted as an invisible component.
 *
 * It renders nothing — it exists so the subscription, the OS notification and
 * the tab-title badge have a React lifetime to live in. It reads the open
 * channel from the router rather than taking it as a prop, so it can be
 * mounted anywhere inside the app shell without new wiring.
 *
 * It is mounted from the sidebar profile card today because that is the one
 * always-present piece of the signed-in shell this change owns. Its natural
 * home is the shell itself (`app/routes/repos.tsx`), which would also let it
 * take the live channel list instead of the localStorage cache; moving it is
 * a one-line change and needs nothing from this module.
 */
export function NotificationRuntime({ selfPubkey }: NotificationRuntimeProps) {
  const navigate = useNavigate();
  const activeChannelId = useRouterState({
    select: (state) => {
      const search = state.location.search as { c?: unknown };
      return typeof search?.c === "string" ? search.c : null;
    },
  });

  useNotificationRuntime({
    selfPubkey,
    activeChannelId,
    onOpenChannel: (channelId) => {
      void navigate({ to: "/repos", search: { c: channelId } });
    },
  });

  return null;
}
