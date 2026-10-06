import { useEffect } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { initReadStateSync } from "./readStateSync.ts";

/**
 * React wiring for NIP-RS read-state sync, extracted from repos.tsx so the
 * route file stays put in the file-size ratchet. Boots the fetch/merge once
 * identity is available. Merged markers land in the read-marker store
 * (features/activity/readMarkers.ts), which re-renders every reader itself —
 * there is no "synced" callback or window event to listen for any more.
 */
export function useReadStateSync(options: {
  session: RelaySession | null;
  selfPubkey: string | null;
}): void {
  const { session, selfPubkey } = options;
  useEffect(() => {
    if (session && selfPubkey) {
      initReadStateSync({ session, selfPubkey });
    }
  }, [session, selfPubkey]);
}
