import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/repos/agents")({
  component: () => (
    <Navigate to="/repos/settings" search={{ group: "agents" }} replace />
  ),
});
