import { AgentsSection } from "@/features/auth/ui/settings/MiscSections";
import { ClaudePoolsSection } from "@/features/auth/ui/settings/ClaudePoolsSection";
import { useDesktopCatalogs } from "../useDesktopCatalogs";
import { useDesktopPresence } from "../useDesktopPresence";
import { adminCommandLock } from "../lib/adminCommandLock";
import { DesktopControlBoundary } from "./DesktopControlBoundary";
import { DesktopConnectionFooter } from "./DesktopConnectionFooter";

/** Presence belongs to the mounted Agents group, never the entire app. */
export function AgentsConnectionSettings() {
  const catalogs = useDesktopCatalogs();
  const presence = useDesktopPresence(catalogs);
  return (
    <div className="space-y-4">
      <AgentsSection />
      <DesktopControlBoundary
        {...presence.lock(catalogs.map((catalog) => catalog.machine))}
      >
        <ClaudePoolsSection
          lockedReason={(command, options) =>
            adminCommandLock(command, options, catalogs, presence.byMachine)
              .reason
          }
        />
      </DesktopControlBoundary>
      <DesktopConnectionFooter
        catalogs={catalogs}
        presence={presence.byMachine}
      />
    </div>
  );
}
