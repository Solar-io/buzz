import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { getMachineHostname } from "@/shared/api/machineIdentity";
import {
  publishDesktopCatalog,
  sealCatalogBlockToOwner,
} from "@/shared/api/tauriDesktopCatalog";
import {
  useAgentPoolProbesQuery,
  useAgentPoolsQuery,
} from "./agentPoolsQueries";
import { buildClaudePoolsPayload } from "./claudePoolsPayload";
import {
  buildDesktopCatalogContent,
  catalogAvailability,
  type DesktopCatalogHarness,
} from "./desktopCatalogContent";
import { useAcpRuntimesQuery, useManagedAgentsQuery } from "./hooks";

/**
 * Kind-30180 desktop-catalog publisher: announces this machine's real harness
 * catalog (custom harnesses included) and the agent pubkeys it can run, so the
 * web client can offer the owner's actual harness list, target admin commands
 * at one machine, and detect registrations no desktop reports. Mounted once in
 * AppShell beside useOwnerAdminCommands.
 *
 * Publish discipline:
 * - Wait for data: never publish while the runtime catalog or managed-agent
 *   list is still loading — an eager `agents: []` would make the web flag
 *   every registration as stale.
 * - Content-hash gate: the body without `updated_at` must differ from the last
 *   published body, or ≥6h must have passed (presence heartbeat), or nothing
 *   is sent. A 60s floor stops flapping data from machine-gunning the relay.
 * - The boot delay runs once per relay (an armed nonce), NOT on every query
 *   refetch — the managed-agent list polls every 5s while an agent runs, and a
 *   delay restarted by each poll would never fire.
 * - All publish state lives in refs (not module singletons): AppShell remounts
 *   on community switch, so switching communities republishes on the new
 *   relay without a `resetCommunityState()` entry.
 */

const BOOT_DELAY_MS = 10_000;
const REPUBLISH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_PUBLISH_SPACING_MS = 60_000;

function contentHash(value: string): string {
  // FNV-1a — this is a change detector, not a security primitive.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function normalizeRelayUrl(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, "");
}

export function useDesktopCatalogPublisher() {
  const { activeCommunity } = useCommunities();
  const runtimesQuery = useAcpRuntimesQuery({ enabled: true });
  const managedAgentsQuery = useManagedAgentsQuery();
  const poolsQuery = useAgentPoolsQuery();
  const probesQuery = useAgentPoolProbesQuery(poolsQuery.data);
  const lastPublishedHash = React.useRef<string | null>(null);
  const lastPublishAt = React.useRef(0);
  const armedForRelay = React.useRef<string | null>(null);
  /** Bumped once the boot delay completes for the current relay. */
  const [armedNonce, setArmedNonce] = React.useState(0);

  const relayUrl = activeCommunity?.relayUrl ?? null;
  const runtimes = runtimesQuery.data;
  const managedAgents = managedAgentsQuery.data;
  const pools = poolsQuery.data;
  const probes = probesQuery.data;
  const dataReady = Boolean(relayUrl && runtimes && managedAgents);

  // Boot delay: once per relay, after the data has loaded.
  React.useEffect(() => {
    if (!dataReady || armedForRelay.current === relayUrl) {
      return;
    }
    let disposed = false;
    const timer = setTimeout(() => {
      if (!disposed) {
        armedForRelay.current = relayUrl;
        setArmedNonce((nonce) => nonce + 1);
      }
    }, BOOT_DELAY_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [dataReady, relayUrl]);

  React.useEffect(() => {
    if (!armedNonce || !relayUrl || !runtimes || !managedAgents) {
      return;
    }
    void (async () => {
      const machine = await getMachineHostname();
      if (!machine) {
        return;
      }
      const harnesses: DesktopCatalogHarness[] = runtimes.map((runtime) => ({
        id: runtime.id,
        label: runtime.label,
        source: runtime.source,
        availability: catalogAvailability(runtime.availability),
      }));
      // Only agents homed on THIS relay — a catalog published to a relay
      // must not claim agents that live on another community's relay.
      const relayAgents = managedAgents.filter(
        (agent) =>
          normalizeRelayUrl(agent.relayUrl) === normalizeRelayUrl(relayUrl),
      );
      const agentPubkeys = relayAgents.map((agent) => agent.pubkey);
      const base = buildDesktopCatalogContent({
        machine,
        harnesses,
        agentPubkeys,
        updatedAt: 0,
      });
      // Owner-only Claude pools block. Hash the PLAINTEXT (NIP-44 output is
      // randomized per call, so hashing ciphertext would republish every
      // 60s); seal only when actually publishing. Absent until the pools
      // file query settles — a missing file still publishes (routing off).
      const poolsPlaintext = pools
        ? JSON.stringify(
            buildClaudePoolsPayload({
              hash: pools.hash,
              parseError: pools.parseError,
              config: pools.config,
              agents: relayAgents.map((agent) => ({
                pubkey: agent.pubkey,
                name: agent.name,
                agentCommand: agent.agentCommand,
                envVars: agent.envVars,
              })),
              accounts: probes ?? {},
            }),
          )
        : null;
      const hash = contentHash(JSON.stringify(base) + (poolsPlaintext ?? ""));
      const now = Date.now();
      if (
        (hash === lastPublishedHash.current &&
          now - lastPublishAt.current < REPUBLISH_INTERVAL_MS) ||
        now - lastPublishAt.current < MIN_PUBLISH_SPACING_MS
      ) {
        return;
      }
      try {
        const claudePoolsSealed = poolsPlaintext
          ? await sealCatalogBlockToOwner(poolsPlaintext)
          : null;
        const content = buildDesktopCatalogContent({
          machine,
          harnesses,
          agentPubkeys,
          updatedAt: Math.floor(now / 1000),
          claudePoolsSealed,
        });
        await publishDesktopCatalog(JSON.stringify(content), machine);
        lastPublishedHash.current = hash;
        lastPublishAt.current = now;
      } catch {
        // Publishing is best-effort presence; the next data change or the
        // 6h heartbeat retries. Never block the shell on it.
      }
    })();
  }, [armedNonce, relayUrl, runtimes, managedAgents, pools, probes]);
}
