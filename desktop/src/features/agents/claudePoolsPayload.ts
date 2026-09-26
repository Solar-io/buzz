/**
 * Plaintext of the catalog-v3 `claude_pools_sealed` block — pure builder, no
 * Tauri imports (node-testable). The publisher NIP-44 seals the JSON of this
 * object to the owner's own key BEFORE it goes on the wire; the plaintext
 * carries home paths, account emails, and per-agent assignments, so it must
 * never be emitted unsealed. Mirror parser:
 * `web/src/features/agents/lib/claudePools.ts`.
 */

export const CLAUDE_POOLS_PAYLOAD_FORMAT = "buzz-claude-pools";

/** Env keys that mean "this agent brings its own auth" (auth_pool.rs GATE_ENV_VARS). */
const CUSTOM_AUTH_ENV = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/** Harness identities buzz-acp treats as Claude (config.rs is_claude_adapter). */
const CLAUDE_ADAPTERS = new Set([
  "claude-agent-acp",
  "claude-code-acp",
  "claude-code",
  "claudecode",
]);

type PoolDef = { label?: string | null; configDir?: string | null };

export type ClaudePoolsConfig = {
  version?: number | null;
  default: string;
  pools: Record<string, PoolDef>;
  assign: Record<string, string>;
  overflow: { enabled: boolean; cooldownMinutes: number };
};

export type ClaudePoolsAgentInput = {
  pubkey: string;
  name: string;
  agentCommand: string;
  envVars: Record<string, string>;
};

export type ClaudePoolsAccount = {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  error: string | null;
};

export type ClaudePoolsPayload = {
  format: typeof CLAUDE_POOLS_PAYLOAD_FORMAT;
  /** File hash — the `baseHash` a `set_claude_pools` must echo back. */
  hash: string;
  parseError: string | null;
  config: ClaudePoolsConfig | null;
  agents: {
    pubkey: string;
    name: string;
    /** Effective pool (assign ?? default); null when routing is off. */
    pool: string | null;
    eligible: boolean;
    /** Why not eligible: "custom-auth" | "non-claude". */
    reason: string | null;
  }[];
  /** Per-pool identity from `claude auth status --json`; absent = not probed yet. */
  accounts: Record<string, ClaudePoolsAccount>;
};

export function normalizeAdapterIdentity(command: string): string {
  const trimmed = command.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const base = (trimmed.split("/").pop() ?? "").toLowerCase();
  const stem = base.replace(/\.(exe|cmd|bat)$/, "");
  return stem.replace(/_/g, "-");
}

export function poolEligibility(agent: ClaudePoolsAgentInput): {
  eligible: boolean;
  reason: string | null;
} {
  if (!CLAUDE_ADAPTERS.has(normalizeAdapterIdentity(agent.agentCommand))) {
    return { eligible: false, reason: "non-claude" };
  }
  const custom = CUSTOM_AUTH_ENV.some(
    (key) => (agent.envVars[key] ?? "").trim().length > 0,
  );
  return custom
    ? { eligible: false, reason: "custom-auth" }
    : { eligible: true, reason: null };
}

/** assign (case-insensitive, trimmed display name) ?? default — auth_pool.rs `assigned_pool`. */
export function effectivePool(
  config: ClaudePoolsConfig | null,
  name: string,
): string | null {
  if (!config || !(config.default in config.pools)) {
    return null;
  }
  const wanted = name.trim().toLowerCase();
  const hit = Object.entries(config.assign).find(
    ([agent]) => agent.trim().toLowerCase() === wanted,
  )?.[1];
  return hit && hit in config.pools ? hit : config.default;
}

/** Deterministic (sorted) so the publisher can hash-compare plaintexts. */
export function buildClaudePoolsPayload(input: {
  hash: string;
  parseError: string | null;
  config: ClaudePoolsConfig | null;
  agents: ClaudePoolsAgentInput[];
  accounts: Record<string, ClaudePoolsAccount>;
}): ClaudePoolsPayload {
  const agents = input.agents
    .map((agent) => {
      const { eligible, reason } = poolEligibility(agent);
      return {
        pubkey: agent.pubkey.trim().toLowerCase(),
        name: agent.name,
        pool: effectivePool(input.config, agent.name),
        eligible,
        reason,
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.pubkey.localeCompare(b.pubkey),
    );
  const accounts: Record<string, ClaudePoolsAccount> = {};
  for (const id of Object.keys(input.accounts).sort()) {
    const probe = input.accounts[id];
    accounts[id] = {
      loggedIn: probe.loggedIn,
      email: probe.email,
      orgName: probe.orgName,
      subscriptionType: probe.subscriptionType,
      error: probe.error,
    };
  }
  return {
    format: CLAUDE_POOLS_PAYLOAD_FORMAT,
    hash: input.hash,
    parseError: input.parseError,
    config: input.config,
    agents,
    accounts,
  };
}
