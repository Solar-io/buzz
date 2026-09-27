import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Kind-30177 managed-agent registry — the public projection every Buzz
 * desktop publishes for each agent it runs (owner-signed, d tag = agent
 * pubkey, parameterized-replaceable). Secrets never ride this event; the
 * runnable config (harness, env, keys) stays in the desktop's local store.
 */

export interface AgentRegistryEntry {
  /** Agent pubkey (the event's d tag). */
  pubkey: string;
  name: string;
  systemPrompt: string;
  model: string;
  provider: string;
  /**
   * Linked persona definition id (the 30177 `persona_id`), or null for a
   * definition-less instance. Definition-linked entries omit the definition
   * quad on the wire ("slimming") — the quad lives in the kind-30175
   * definition event.
   */
  personaId: string | null;
  /** Spawn-time parallelism cap from the 30177 content; null when absent. */
  parallelism: number | null;
  /** "owner-only" | "anyone" | "allowlist" — who may summon the agent. */
  respondTo: string;
  respondToAllowlist: string[];
  /** Event created_at — the merge key for replaceable updates. */
  updatedAt: number;
  /** Display-only effort/context knobs (30177 `effort`); null when absent. */
  effort: AgentEffort | null;
}

/**
 * The 30177 `effort` block — named, validated knobs the desktop publishes
 * (`desktop/src-tauri/src/managed_agents/agent_effort.rs`). Never env.
 */
export interface AgentEffort {
  acp: string | null;
  textTurn: string | null;
  voiceTurn: string | null;
  thinking: string | null;
  claudeCode: string | null;
  maxContextTokens: number | null;
}

// Same token rule the Rust writer publishes under. Deliberately NO trim here:
// the writer trims (ASCII whitespace only) before publishing, so a padded
// token on the wire is malformed and dropped — see AGENTS.md "the built-ins
// are the drift". Shared corpus: test-fixtures/agent-effort/cases.json.
const EFFORT_TOKEN = /^[a-z]{1,16}$/;

/** Parse a raw 30177 `effort` value; null for missing/junk/all-empty. */
export function parseAgentEffort(raw: unknown): AgentEffort | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const token = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" &&
      EFFORT_TOKEN.test(value) &&
      value !== "unset"
      ? value
      : null;
  };
  const context = record.max_context_tokens;
  const effort: AgentEffort = {
    acp: token("acp"),
    textTurn: token("text_turn"),
    voiceTurn: token("voice_turn"),
    thinking: token("thinking"),
    claudeCode: token("claude_code"),
    maxContextTokens:
      typeof context === "number" &&
      Number.isSafeInteger(context) &&
      context > 0
        ? context
        : null,
  };
  return Object.values(effort).some((value) => value !== null) ? effort : null;
}

/** Parse one 30177 projection; null for wrong-shape events. */
export function agentFromEvent(
  event: SignedNostrEvent,
): AgentRegistryEntry | null {
  if (event.kind !== 30177) {
    return null;
  }
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!dTag || !/^[0-9a-f]{64}$/.test(dTag)) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (key: string): string =>
    typeof parsed[key] === "string" ? (parsed[key] as string) : "";
  const allowlist = parsed.respond_to_allowlist;
  const parallelism = parsed.parallelism;
  return {
    pubkey: dTag,
    name: str("name") || dTag.slice(0, 8),
    systemPrompt: str("system_prompt"),
    model: str("model"),
    provider: str("provider"),
    personaId: str("persona_id") || null,
    parallelism:
      typeof parallelism === "number" &&
      Number.isFinite(parallelism) &&
      parallelism > 0
        ? Math.floor(parallelism)
        : null,
    respondTo: str("respond_to") || "owner-only",
    respondToAllowlist: Array.isArray(allowlist)
      ? allowlist.filter((pk): pk is string => typeof pk === "string")
      : [],
    updatedAt: event.created_at,
    effort: parseAgentEffort(parsed.effort),
  };
}

/** Newest-wins merge into a registry map (replaceable coordinate = pubkey). */
export function mergeAgentEntry(
  registry: Map<string, AgentRegistryEntry>,
  entry: AgentRegistryEntry,
): Map<string, AgentRegistryEntry> {
  const existing = registry.get(entry.pubkey);
  if (existing && existing.updatedAt >= entry.updatedAt) {
    return registry;
  }
  const next = new Map(registry);
  next.set(entry.pubkey, entry);
  return next;
}
