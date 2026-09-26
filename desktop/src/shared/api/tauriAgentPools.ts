import { invokeTauri } from "@/shared/api/tauri";

/**
 * Two-account Claude pool routing (`~/.buzz/agent-pools.json`) — thin
 * wrappers over the `agent_pools.rs` Tauri commands. Types mirror that
 * module's serde shapes (camelCase).
 */

export type AgentPoolDef = {
  label?: string | null;
  /** `null` = inherit (the ~/.claude account; CLAUDE_CONFIG_DIR unset). */
  configDir?: string | null;
};

export type AgentPoolsConfig = {
  version?: number | null;
  default: string;
  pools: Record<string, AgentPoolDef>;
  assign: Record<string, string>;
  overflow: { enabled: boolean; cooldownMinutes: number };
};

export type AgentPoolsSnapshot = {
  config: AgentPoolsConfig | null;
  /** sha256 of the file bytes; "" when the file does not exist. */
  hash: string;
  parseError: string | null;
};

export type AgentPoolProbe = {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
  configDirectory: string | null;
  error: string | null;
};

export function getAgentPools(): Promise<AgentPoolsSnapshot> {
  return invokeTauri<AgentPoolsSnapshot>("get_agent_pools");
}

export function setAgentPools(
  config: AgentPoolsConfig,
  baseHash: string | null,
): Promise<AgentPoolsSnapshot> {
  return invokeTauri<AgentPoolsSnapshot>("set_agent_pools", {
    config,
    baseHash,
  });
}

export function probeAgentPool(
  configDir: string | null,
): Promise<AgentPoolProbe> {
  return invokeTauri<AgentPoolProbe>("probe_agent_pool", { configDir });
}
