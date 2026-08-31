import { createFileRoute } from "@tanstack/react-router";
import { AgentsAdminPage } from "@/features/agents/ui/AgentsAdminPage";

export const Route = createFileRoute("/repos/agents")({
  component: AgentsAdminPage,
});
