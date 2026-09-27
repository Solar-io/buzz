import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import {
  effectiveHiddenDms,
  hiddenDmSnapshotFilter,
  hideDmEventTemplate,
  isHiddenDmMigrationDone,
  loadHiddenDms,
  markHiddenDmMigrationDone,
  migrationCandidates,
  newerSnapshot,
  parseHiddenSnapshot,
  saveHiddenDms,
  type HiddenSnapshot,
  type PendingHideChange,
} from "./lib/hiddenDms.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function publishHide(
  session: RelaySession,
  channelId: string,
): Promise<boolean> {
  try {
    const event = await signNostrEvent(hideDmEventTemplate(channelId));
    const result = await session.publish(event);
    if (!result.ok) {
      console.warn("[dms] hide (41012) rejected", channelId, result.message);
    }
    return result.ok;
  } catch (error) {
    console.warn("[dms] hide (41012) failed", channelId, error);
    return false;
  }
}

/**
 * Relay-synced hidden DMs (NIP-DV). Subscribes live to the viewer's own
 * kind:30622 snapshot — so a hide on desktop/mobile removes the row here
 * without reload — and applies optimistic local changes until a snapshot
 * supersedes them. Runs the one-time localStorage→relay migration after the
 * first EOSE.
 */
export function useHiddenDms(
  session: RelaySession,
  selfPubkey: string | null,
): {
  hiddenDmIds: string[];
  hide: (channelId: string) => void;
  /** The DM was (re-)opened via 41010, which the relay treats as unhide. */
  markOpened: (channelId: string) => void;
} {
  const [cached] = useState<string[]>(() => loadHiddenDms(window.localStorage));
  const [snapshot, setSnapshot] = useState<HiddenSnapshot | null>(null);
  const [pending, setPending] = useState<Map<string, PendingHideChange>>(
    () => new Map(),
  );
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const migratedFor = useRef<string | null>(null);

  useEffect(() => {
    setSnapshot(null);
    setSettledFor(null);
    if (!selfPubkey) return;
    return session.subscribe(hiddenDmSnapshotFilter(selfPubkey), {
      onEvent: (event) => {
        const parsed = parseHiddenSnapshot(event, selfPubkey);
        if (parsed) setSnapshot((current) => newerSnapshot(current, parsed));
      },
      onEose: () => setSettledFor(selfPubkey),
      priority: "critical",
    });
  }, [session, selfPubkey]);

  // One-time migration: local-only hides the relay has never seen.
  useEffect(() => {
    if (!selfPubkey || settledFor !== selfPubkey) return;
    if (migratedFor.current === selfPubkey) return;
    migratedFor.current = selfPubkey;
    if (isHiddenDmMigrationDone(window.localStorage, selfPubkey)) return;
    const candidates = migrationCandidates(cached, snapshot);
    if (candidates.length === 0) {
      markHiddenDmMigrationDone(window.localStorage, selfPubkey);
      return;
    }
    const at = nowSeconds();
    setPending((previous) => {
      const next = new Map(previous);
      for (const id of candidates) {
        if (!next.has(id)) next.set(id, { hidden: true, at });
      }
      return next;
    });
    void Promise.all(candidates.map((id) => publishHide(session, id))).then(
      (results) => {
        if (results.every(Boolean)) {
          markHiddenDmMigrationDone(window.localStorage, selfPubkey);
        }
      },
    );
  }, [session, selfPubkey, settledFor, snapshot, cached]);

  const { hidden } = useMemo(
    () => effectiveHiddenDms(snapshot, cached, pending),
    [snapshot, cached, pending],
  );

  useEffect(() => {
    saveHiddenDms(window.localStorage, hidden);
  }, [hidden]);

  const setChange = useCallback((channelId: string, isHidden: boolean) => {
    setPending((previous) => {
      const next = new Map(previous);
      next.set(channelId, { hidden: isHidden, at: nowSeconds() });
      return next;
    });
  }, []);

  const hide = useCallback(
    (channelId: string) => {
      setChange(channelId, true);
      void publishHide(session, channelId);
    },
    [session, setChange],
  );
  const markOpened = useCallback(
    (channelId: string) => setChange(channelId, false),
    [setChange],
  );

  return { hiddenDmIds: hidden, hide, markOpened };
}
