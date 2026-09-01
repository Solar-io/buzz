import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import {
  desktopCatalogFromEvent,
  mergeDesktopCatalog,
  type DesktopCatalog,
} from "@/features/agents/lib/desktopCatalog";

/**
 * The owner's kind-30180 desktop catalogs, live from the relay — one per
 * machine the owner runs Buzz Desktop on. Replaceable events, newest-wins per
 * machine (d tag = hostname).
 */
export function useDesktopCatalogs(): DesktopCatalog[] {
  const { session, status } = useRelaySession();
  const [catalogs, setCatalogs] = useState<Map<string, DesktopCatalog>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!session || status !== "open") {
      return;
    }
    let alive = true;
    let cleanup: (() => void) | null = null;
    void ownPubkey().then((pubkey) => {
      if (!alive || !pubkey) {
        return;
      }
      cleanup = session.subscribe(
        { kinds: [30180], authors: [pubkey], limit: 100 },
        {
          onEvent: (event) => {
            const catalog = desktopCatalogFromEvent(event);
            if (catalog) {
              setCatalogs((previous) => mergeDesktopCatalog(previous, catalog));
            }
          },
        },
      );
    });
    return () => {
      alive = false;
      cleanup?.();
    };
  }, [session, status]);

  return Array.from(catalogs.values()).sort((a, b) =>
    a.machine.localeCompare(b.machine),
  );
}
