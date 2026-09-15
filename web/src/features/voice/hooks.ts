import { useEffect, useMemo, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  KIND_VOICE_CATALOG,
  reduceVoiceCatalogEvents,
  type CatalogEventLike,
  type VoiceCatalogRow,
} from "./lib/voiceCatalog.ts";

/**
 * Live community voice catalog (kind 30181).
 *
 * One REQ covers the initial read and live fan-out — the relay answers with
 * the stored replaceable events, then keeps the subscription open (the
 * user-status pattern). The filter names `kinds` explicitly, which the
 * relay's p-gate requires of every query. There are no module-level caches:
 * one community per origin, so nothing survives a remount that should not.
 *
 * `ready` flips true on the subscription's EOSE, i.e. the initial historical
 * read is complete — a picker can use it to distinguish "empty catalog" from
 * "still loading".
 */
export function useVoiceCatalog(): {
  rows: VoiceCatalogRow[];
  ready: boolean;
} {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<CatalogEventLike[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setEvents([]);
    setReady(false);
    return session.subscribe(
      { kinds: [KIND_VOICE_CATALOG], limit: 500 },
      {
        onEvent: (event: SignedNostrEvent) => {
          setEvents((previous) => [...previous, event]);
        },
        onEose: () => setReady(true),
      },
    );
  }, [session]);

  const rows = useMemo(
    () => Array.from(reduceVoiceCatalogEvents(events).values()),
    [events],
  );
  return { rows, ready };
}
