import { useEffect, useMemo, useState } from "react";
import { verifyEvent } from "nostr-tools/pure";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  catalogPublicationsByKey,
  mergeVerifiedCatalogEvent,
  publicationsFromVerifiedEvents,
  type CatalogPublication,
} from "@/features/agents/lib/personaCatalog";

/**
 * The COMMUNITY persona catalog — an ALL-AUTHORS kind-30175 subscription.
 * Unlike usePersonas (author-scoped, the owner's own definitions), no
 * `authors` filter is sent: the relay's shared-gate is the access control,
 * delivering only `["shared","true"]` events to any authenticated member
 * (kind.rs SHARED_GATED_KINDS — verified live 2026-09-03: a non-owner
 * all-authors REQ is accepted and unshared events are withheld relay-side).
 * That is why this works identically for the owner and for a signed-in
 * community member browsing the open-source catalog.
 *
 * Signature verification: the desktop verifies Schnorr per page before
 * projecting (persona_catalog.rs:86-94); the web mirrors that defense-in-depth
 * with nostr-tools `verifyEvent` per event via the injectable `verifyFn`
 * (the seam to batch/sample if perf ever matters). Unverified events are
 * dropped before they can claim a coordinate.
 */
export type CatalogVerifyFn = (event: SignedNostrEvent) => boolean;

export function usePersonaCatalog(
  verifyFn: CatalogVerifyFn = verifyEvent as CatalogVerifyFn,
): { publications: Map<string, CatalogPublication>; count: number } {
  const { session, status } = useRelaySession();
  const [events, setEvents] = useState<Map<string, SignedNostrEvent>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!session || status !== "open") {
      return;
    }
    let cleanup: (() => void) | null = null;
    // Deliberately all-authors (no `authors`): the relay gate filters. A
    // 500-event cap mirrors the desktop's page-1 size; the shared opt-in set
    // is small by construction.
    cleanup = session.subscribe(
      { kinds: [30175], limit: 500 },
      {
        onEvent: (event) => {
          let verified = false;
          try {
            verified = verifyFn(event);
          } catch {
            verified = false;
          }
          if (verified) {
            setEvents((previous) => mergeVerifiedCatalogEvent(previous, event));
          }
        },
      },
    );
    return () => {
      cleanup?.();
    };
  }, [session, status, verifyFn]);

  const publications = useMemo(
    () =>
      catalogPublicationsByKey(publicationsFromVerifiedEvents(events.values())),
    [events],
  );

  return { publications, count: publications.size };
}
