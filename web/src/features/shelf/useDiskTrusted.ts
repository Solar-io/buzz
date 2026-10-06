import { useMemo } from "react";

import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useWorkContext } from "@/features/work/workContext.ts";
import { diskTrusted } from "./lib/diskDocument.ts";

/**
 * Whether the Canvas may open a share's path on disk with the viewer's stash
 * session (diskDocument.ts `diskTrusted`): the viewer's own share, or one by
 * an agent in the viewer's OWN kind-30177 registry (owner-signed, authored by
 * this viewer's key).
 *
 * Deliberately NOT the shell's general `agentPubkeys` (verifier finding,
 * 2026-10-05): that set also merges observer-frame keys, which come from an
 * event's `agent` tag the client does not check against the signer — fine for
 * an avatar badge, not for a filesystem read/write.
 */
export function useDiskTrusted(authorPubkey: string | null): boolean {
  const selfPubkey = useWorkContext()?.selfPubkey ?? null;
  const registry = useAgentRegistry();
  const registered = useMemo(
    () => new Set(registry.map((entry) => entry.pubkey.toLowerCase())),
    [registry],
  );
  return diskTrusted(authorPubkey, selfPubkey, registered);
}
