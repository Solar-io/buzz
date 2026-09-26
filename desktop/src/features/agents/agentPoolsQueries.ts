import { useQuery } from "@tanstack/react-query";

import {
  getAgentPools,
  probeAgentPool,
  type AgentPoolProbe,
  type AgentPoolsSnapshot,
} from "@/shared/api/tauriAgentPools";

export const agentPoolsQueryKey = ["agent-pools"] as const;

/** `~/.buzz/agent-pools.json` — polled slowly; hand edits show up within a minute. */
export function useAgentPoolsQuery() {
  return useQuery<AgentPoolsSnapshot>({
    queryKey: agentPoolsQueryKey,
    queryFn: getAgentPools,
    refetchInterval: 60_000,
  });
}

/**
 * `claude auth status --json` per pool (identity only). Spawns the CLI once
 * per pool, so it is cached for 10 minutes and keyed by the pool→dir map.
 */
export function useAgentPoolProbesQuery(
  snapshot: AgentPoolsSnapshot | undefined,
) {
  const pools = snapshot?.config?.pools ?? null;
  const dirs = pools
    ? Object.keys(pools)
        .sort()
        .map((id) => [id, pools[id]?.configDir ?? null] as const)
    : [];
  return useQuery<Record<string, AgentPoolProbe>>({
    queryKey: ["agent-pool-probes", dirs],
    enabled: dirs.length > 0,
    staleTime: 10 * 60_000,
    refetchInterval: 15 * 60_000,
    queryFn: async () => {
      const entries = await Promise.all(
        dirs.map(async ([id, dir]) => {
          try {
            return [id, await probeAgentPool(dir)] as const;
          } catch (error) {
            return [
              id,
              {
                loggedIn: false,
                email: null,
                orgName: null,
                subscriptionType: null,
                authMethod: null,
                configDirectory: null,
                error: error instanceof Error ? error.message : String(error),
              },
            ] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    },
  });
}
