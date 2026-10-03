import { Monitor } from "lucide-react";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { DesktopPresence } from "../lib/desktopPresence";
import { useTick } from "./WorkingBadge";

/** Last-seen is a successful ping time, never a catalog publication time. */
export function DesktopConnectionFooter({
  catalogs,
  presence,
}: {
  catalogs: readonly DesktopCatalog[];
  presence: ReadonlyMap<string, DesktopPresence>;
}) {
  useTick(catalogs.length > 0);
  if (catalogs.length === 0)
    return (
      <p className="text-xs text-muted-foreground" role="status">
        No Buzz Desktop has connected yet.
      </p>
    );
  return (
    <div
      className="space-y-2 border-t border-border pt-3"
      data-testid="desktop-connection-footer"
      role="status"
    >
      {catalogs.map((catalog) => {
        const state = presence.get(catalog.machine);
        const status = state?.status ?? "unknown";
        const seconds =
          state?.lastSeen == null
            ? null
            : Math.max(0, Math.floor((Date.now() - state.lastSeen) / 1000));
        const ago =
          seconds === null
            ? "never connected"
            : seconds < 60
              ? `${seconds}s ago`
              : `${Math.floor(seconds / 60)} min ago`;
        return (
          <div
            key={catalog.machine}
            className={
              status === "offline"
                ? "text-coral-ink"
                : status === "online"
                  ? "text-leaf-ink"
                  : "text-muted-foreground"
            }
          >
            <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
              <Monitor aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 break-words">
                Buzz Desktop · {catalog.machine.replace(/\.local$/, "")}
              </span>
            </div>
            <p className="mt-1 pl-6 text-2xs">
              {status === "unknown"
                ? "status unknown — update Buzz Desktop"
                : status === "checking"
                  ? "Connecting…"
                  : status === "offline"
                    ? `offline · last seen ${ago}`
                    : `online · ${ago}`}
            </p>
          </div>
        );
      })}
    </div>
  );
}
