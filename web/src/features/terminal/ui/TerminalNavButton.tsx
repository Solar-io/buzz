import { useNavigate, useSearch } from "@tanstack/react-router";
import { SquareTerminal } from "lucide-react";
import { useMemo } from "react";

import { SidebarNavButton } from "@/features/sidebar/ui/SidebarNavButton";
import { useActiveWebView } from "@/features/webPanels/activeWebStore.ts";
import { hatchUrl } from "../lib/hatchConfig.ts";

/**
 * The sidebar's Terminal row (Terminal artboard), after Files. Renders
 * NOTHING unless a hatch URL is configured — no row that leads to a dead page.
 * Self-contained (reads `?view=` and navigates itself) so the sidebar only
 * places it.
 */
export function TerminalNavButton() {
  const configured = useMemo(() => hatchUrl() !== null, []);
  const view = useSearch({
    strict: false,
    select: (search) => (search as { view?: string }).view,
  });
  const navigate = useNavigate();
  const web = useActiveWebView();
  if (!configured) {
    return null;
  }
  const onTerminal = view === "terminal";
  return (
    <SidebarNavButton
      selected={onTerminal && web.state.active === null}
      label="Terminal"
      icon={<SquareTerminal aria-hidden className="size-4 shrink-0" />}
      onSelect={() => {
        // Already here under Files: the layer is what covers it.
        if (onTerminal) {
          web.hide();
          return;
        }
        void navigate({ to: "/repos", search: { view: "terminal" } });
      }}
    />
  );
}
