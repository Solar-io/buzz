import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/features/auth/ui/SettingsPage";
import { parseSettingsSearch } from "@/features/auth/ui/settings/settingsGroups";

export const Route = createFileRoute("/repos/settings")({
  validateSearch: parseSettingsSearch,
  component: SettingsRoute,
});
function SettingsRoute() {
  return <SettingsPage {...Route.useSearch()} />;
}
