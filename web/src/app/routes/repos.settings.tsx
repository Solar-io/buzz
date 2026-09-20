import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/features/auth/ui/SettingsPage";
import {
  parseSettingsGroup,
  type SettingsGroupId,
} from "@/features/auth/ui/settings/settingsGroups";

export const Route = createFileRoute("/repos/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { group?: SettingsGroupId } => {
    // The selected settings pane travels in the URL so any group is
    // linkable; anything unparsable falls back to the page's default
    // (Account), same pattern as `?view=` on /repos. The key stays ABSENT
    // when unset — a required `group` property here would force every
    // `<Link to="/repos/settings">` in the app to pass `search`.
    const group = parseSettingsGroup(search.group);
    return group ? { group } : {};
  },
  component: SettingsRoute,
});

/** Hands the validated `group` param to the page as a plain prop. */
function SettingsRoute() {
  const { group } = Route.useSearch();
  return <SettingsPage group={group} />;
}
