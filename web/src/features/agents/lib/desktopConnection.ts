import type { DesktopCatalog } from "./desktopCatalog";
import type { AgentRegistryEntry } from "./agentRegistry";

// Catalogs heartbeat every six hours; allow five minutes for clock skew.
const FRESH_REPORT_SECONDS = 6 * 60 * 60 + 5 * 60;
export function ownsSettingsAgents(
  catalogs: readonly DesktopCatalog[],
  registry: readonly AgentRegistryEntry[],
  now = Date.now() / 1000,
): boolean {
  return (
    registry.length > 0 ||
    catalogs.some(
      (catalog) =>
        catalog.updatedAt <= now + 300 &&
        now - catalog.updatedAt <= FRESH_REPORT_SECONDS,
    )
  );
}
/** A report is historical evidence, never a desktop liveness check. */
export function desktopConnection(
  catalog: DesktopCatalog,
  now = Date.now() / 1000,
): string {
  const seconds = Math.max(0, Math.floor(now - catalog.updatedAt));
  const age =
    seconds < 60
      ? "just now"
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h ago`
          : `${Math.floor(seconds / 86400)}d ago`;
  return `Buzz Desktop · ${catalog.machine.replace(/\.local$/, "")} · last reported ${age}`;
}
