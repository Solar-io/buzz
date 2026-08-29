import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/features/auth/ui/SettingsPage";

export const Route = createFileRoute("/repos/settings")({
  component: SettingsPage,
});
