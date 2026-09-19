import { Headphones } from "lucide-react";

import { router } from "@/app/router";

import { useHuddleSession } from "../HuddleSessionProvider.tsx";

/**
 * "In huddle" — the call's only trace when neither the dock nor the panel
 * is on screen.
 *
 * The dock is deliberately docked to one room, so walking to another
 * channel hides it while the call keeps running. Without this the mic would
 * be live with nothing on screen saying so, which is both a privacy problem
 * and the reason people end up in two huddles at once. Clicking goes back.
 *
 * It navigates through the router SINGLETON rather than `useNavigate`,
 * because the provider that renders it sits above `RouterProvider` and has
 * no router context of its own.
 */
export function HuddlePill() {
  const { call } = useHuddleSession();
  const target = call.parentChannelId ?? call.channelId;
  if (target === null) {
    return null;
  }
  return (
    <button
      className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-emerald-600/50 bg-emerald-600/20 px-3 py-1.5 text-xs font-medium text-emerald-300 shadow-lg hover:bg-emerald-600/30"
      data-testid="huddle-pill"
      onClick={() => {
        void router.navigate({ to: "/repos", search: { c: target } });
      }}
      title="Back to the huddle"
      type="button"
    >
      <Headphones aria-hidden className="h-3.5 w-3.5" />
      In huddle
    </button>
  );
}
