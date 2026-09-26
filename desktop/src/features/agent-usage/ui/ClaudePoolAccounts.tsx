import {
  useAgentPoolProbesQuery,
  useAgentPoolsQuery,
} from "@/features/agents/agentPoolsQueries";
import { effectivePool } from "@/features/agents/claudePoolsPayload";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { UsageCard } from "./UsageCharts";

/**
 * Both Claude accounts side by side (two-account pool routing). REAL data:
 * the identity `claude auth status --json` reports per pool config dir, and
 * how many agents `~/.buzz/agent-pools.json` routes to each pool. NOT
 * available: remaining weekly quota — the Claude CLI exposes no quota read,
 * and buzz-acp's 429 overflow state lives in each agent process's memory
 * only, so neither is shown as if it were known.
 */
export function ClaudePoolAccounts() {
  const poolsQuery = useAgentPoolsQuery();
  const probesQuery = useAgentPoolProbesQuery(poolsQuery.data);
  const agentsQuery = useManagedAgentsQuery();
  const config = poolsQuery.data?.config ?? null;
  const counts = new Map<string, number>();
  for (const agent of agentsQuery.data ?? []) {
    const pool = effectivePool(config, agent.name);
    if (pool) {
      counts.set(pool, (counts.get(pool) ?? 0) + 1);
    }
  }
  return (
    <UsageCard
      title="Claude accounts (pools)"
      subtitle="Identity is live from claude auth status; remaining weekly quota is not exposed by Claude and is not shown"
    >
      {poolsQuery.isPending && (
        <p className="usage-empty" role="status">
          Loading pools…
        </p>
      )}
      {poolsQuery.data?.parseError && (
        <p className="usage-empty" role="alert">
          agent-pools.json does not parse: {poolsQuery.data.parseError}
        </p>
      )}
      {poolsQuery.data && !config && !poolsQuery.data.parseError && (
        <p className="usage-empty">
          Pool routing is off (no ~/.buzz/agent-pools.json). All agents use the
          default ~/.claude login.
        </p>
      )}
      {config && (
        <ul className="usage-attribution-list">
          {Object.entries(config.pools)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, def]) => {
              const probe = probesQuery.data?.[id];
              return (
                <li key={id} data-confirmed={probe?.loggedIn ?? false}>
                  <div className="usage-attribution-row">
                    <div>
                      <strong>
                        Pool {id}
                        {def.label ? ` · ${def.label}` : ""}
                        {config.default === id ? " (default)" : ""}
                      </strong>
                      <span>
                        {probe
                          ? probe.loggedIn
                            ? `${probe.email ?? "unknown email"}${
                                probe.subscriptionType
                                  ? ` · ${probe.subscriptionType}`
                                  : ""
                              }${probe.orgName ? ` · ${probe.orgName}` : ""}`
                            : `Not logged in${probe.error ? ` — ${probe.error}` : ""}`
                          : probesQuery.isFetching
                            ? "Checking login…"
                            : "Login not checked"}
                      </span>
                      <span>
                        Config dir: {def.configDir ?? "default (~/.claude)"} ·{" "}
                        {counts.get(id) ?? 0} agent(s) routed here · Weekly
                        usage remaining: unavailable · Last 429/overflow:
                        unavailable (per-process, not recorded)
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
        </ul>
      )}
    </UsageCard>
  );
}
