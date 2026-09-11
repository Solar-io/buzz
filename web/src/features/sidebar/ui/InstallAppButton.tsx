import { Download } from "lucide-react";

import { useInstallPrompt } from "@/shared/pwa/useInstallPrompt";

/**
 * Sidebar offer to install Buzz as an app, next to the profile card.
 *
 * Rendered only while the browser is holding a live `beforeinstallprompt`
 * (see {@link useInstallPrompt}): invisible in an already-installed app,
 * in browsers with nothing to offer, and after the user answers the prompt.
 * Row styling matches the sidebar's quiet hover rows so it reads as part of
 * the same surface.
 */
export function InstallAppButton() {
  const install = useInstallPrompt();
  if (install.phase !== "available") {
    return null;
  }
  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        data-testid="install-app-button"
        className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm text-sidebar-foreground/70 transition-colors hover:bg-white/5 hover:text-foreground"
        onClick={install.prompt}
      >
        <Download aria-hidden className="h-4 w-4 shrink-0" />
        Install Buzz
      </button>
    </div>
  );
}
