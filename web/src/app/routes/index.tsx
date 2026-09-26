import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";

import { restoredLandingTarget } from "@/features/channels/lib/lastConversationScope.ts";

/** "/" is the relay's NIP-11/info endpoint — the app itself lives at /repos. */
export const Route = createFileRoute("/")({
  // Straight to the last conversation (plan item 5), skipping the bare
  // /repos hop; with nothing stored, /repos decides as before.
  beforeLoad: () => {
    const target = restoredLandingTarget({});
    if (target !== null) {
      throw redirect({ to: "/repos", search: { c: target }, replace: true });
    }
  },
  component: () => <Navigate to="/repos" />,
});
