import {
  parseClaudePoolsConfig,
  type ClaudePoolsConfig,
} from "./adminCommands.ts";

/**
 * Catalog-v3 Claude pools block — decrypted plaintext parse (pure; the
 * component does the owner-key NIP-44 decrypt). Mirror of the desktop
 * builder `desktop/src/features/agents/claudePoolsPayload.ts`.
 */

/** Catalog version whose desktop applies `set_claude_pools`. */
export const CLAUDE_POOLS_CATALOG_VERSION = 3;

export interface ClaudePoolsAgentRow {
  pubkey: string;
  name: string;
  pool: string | null;
  eligible: boolean;
  reason: string | null;
}

export interface ClaudePoolsAccount {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  error: string | null;
}

export interface ClaudePoolsPayload {
  hash: string;
  parseError: string | null;
  config: ClaudePoolsConfig | null;
  agents: ClaudePoolsAgentRow[];
  accounts: Record<string, ClaudePoolsAccount>;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parseClaudePoolsPayload(
  value: unknown,
): ClaudePoolsPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.format !== "buzz-claude-pools" || typeof raw.hash !== "string") {
    return null;
  }
  const agents = Array.isArray(raw.agents)
    ? raw.agents.flatMap((entry): ClaudePoolsAgentRow[] => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const a = entry as Record<string, unknown>;
        if (typeof a.pubkey !== "string" || typeof a.name !== "string") {
          return [];
        }
        return [
          {
            pubkey: a.pubkey,
            name: a.name,
            pool: text(a.pool),
            eligible: a.eligible === true,
            reason: text(a.reason),
          },
        ];
      })
    : [];
  const accounts: Record<string, ClaudePoolsAccount> = {};
  if (typeof raw.accounts === "object" && raw.accounts !== null) {
    for (const [id, entry] of Object.entries(raw.accounts)) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const p = entry as Record<string, unknown>;
      accounts[id] = {
        loggedIn: p.loggedIn === true,
        email: text(p.email),
        orgName: text(p.orgName),
        subscriptionType: text(p.subscriptionType),
        error: text(p.error),
      };
    }
  }
  return {
    hash: raw.hash,
    parseError: text(raw.parseError),
    config: raw.config == null ? null : parseClaudePoolsConfig(raw.config),
    agents,
    accounts,
  };
}

/**
 * Build the next pools document from the editor state. Only agents whose
 * pool differs from the default get an `assign` entry, keeping the file the
 * short hand-editable shape; assignments for names not in this catalog
 * (other machines, retired agents) are preserved untouched.
 */
export function nextPoolsConfig(
  base: ClaudePoolsConfig,
  edits: {
    defaultPool: string;
    pools: ClaudePoolsConfig["pools"];
    agentPools: Record<string, string>;
  },
): ClaudePoolsConfig {
  const edited = new Set(
    Object.keys(edits.agentPools).map((n) => n.trim().toLowerCase()),
  );
  const assign: Record<string, string> = {};
  for (const [name, pool] of Object.entries(base.assign)) {
    if (!edited.has(name.trim().toLowerCase())) {
      assign[name] = pool;
    }
  }
  for (const [name, pool] of Object.entries(edits.agentPools)) {
    if (pool !== edits.defaultPool) {
      assign[name] = pool;
    }
  }
  return {
    ...base,
    version: base.version ?? 1,
    default: edits.defaultPool,
    pools: edits.pools,
    assign,
  };
}
