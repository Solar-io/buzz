import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import { desktopConnection } from "../lib/desktopConnection";

export function DesktopConnectionFooter({
  catalogs,
}: {
  catalogs: readonly DesktopCatalog[];
}) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div
      className="space-y-2 border-t border-sidebar-border px-4 py-3 text-xs text-muted-foreground"
      data-testid="desktop-connection-footer"
    >
      {catalogs.length ? (
        catalogs.map((catalog) => (
          <p className="flex items-start gap-2" key={catalog.machine}>
            <Monitor aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              {desktopConnection(catalog, now)}
            </span>
          </p>
        ))
      ) : (
        <p>No Buzz Desktop report yet.</p>
      )}
    </div>
  );
}
