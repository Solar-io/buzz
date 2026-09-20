import { useEffect, useRef } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { READ_STATE_SYNCED_EVENT, initReadStateSync } from "./readStateSync.ts";

/**
 * React wiring for NIP-RS read-state sync, extracted from repos.tsx so the
 * route file stays put in the file-size ratchet (same extraction pattern as
 * usePermalinkCleanup). Boots the fetch/merge once identity is available,
 * then re-reads localStorage whenever the boot merge lands — the shell's
 * `setReadState` is the same external-change reread the tab-focus path
 * already performs.
 *
 * One effect, not two: the synced event can only fire after init, and init
 * only runs inside this effect, so the listener's lifetime can share the
 * effect's. The callback rides a ref so a new closure per render never
 * re-runs the (idempotent) init.
 */
export function useReadStateSync(options: {
  session: RelaySession | null;
  selfPubkey: string | null;
  /** Called when the boot merge has written new markers to localStorage. */
  onSynced: () => void;
}): void {
  const { session, selfPubkey } = options;
  const onSyncedRef = useRef(options.onSynced);
  onSyncedRef.current = options.onSynced;
  useEffect(() => {
    const listener = () => onSyncedRef.current();
    window.addEventListener(READ_STATE_SYNCED_EVENT, listener);
    if (session && selfPubkey) {
      initReadStateSync({ session, selfPubkey });
    }
    return () => {
      window.removeEventListener(READ_STATE_SYNCED_EVENT, listener);
    };
  }, [session, selfPubkey]);
}
