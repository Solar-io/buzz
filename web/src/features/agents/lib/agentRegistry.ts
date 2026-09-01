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
  /** "owner-only" | "anyone" | "allowlist" — who may summon the agent. */
  respondTo: string;
  respondToAllowlist: string[];
  /** Event created_at — the merge key for replaceable updates. */
  updatedAt: number;
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
  return {
    pubkey: dTag,
    name: str("name") || dTag.slice(0, 8),
    systemPrompt: str("system_prompt"),
    model: str("model"),
    provider: str("provider"),
    respondTo: str("respond_to") || "owner-only",
    respondToAllowlist: Array.isArray(allowlist)
      ? allowlist.filter((pk): pk is string => typeof pk === "string")
      : [],
    updatedAt: event.created_at,
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
