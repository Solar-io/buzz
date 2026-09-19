import { createFileRoute, Navigate } from "@tanstack/react-router";
import { isNativeIOS } from "@/shared/platform/native";
import { AgentsAdminPage } from "@/features/agents/ui/AgentsAdminPage";

export const Route = createFileRoute("/repos/agents")({
  component: () => isNativeIOS() ? <Navigate to="/repos" /> : <AgentsAdminPage />,
});
