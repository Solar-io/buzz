import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  agentFromEvent,
  mergeAgentEntry,
  type AgentRegistryEntry,
} from "./agentRegistry";
import { admitAfterTombstone, applyTombstone, withoutKey } from "./tombstones";

/** Owner registry heads and the deletion floors that prevent replay resurrection. */
export interface RegistryState {
  registry: Map<string, AgentRegistryEntry>;
  tombstones: Map<string, number>;
}

/** Apply the desktop's existing registration or NIP-09 coordinate tombstone. */
export function applyRegistryEvent(
  state: RegistryState,
  event: SignedNostrEvent,
  owner: string,
): RegistryState {
  if (event.pubkey !== owner) return state;
  if (event.kind === 30177) {
    const entry = agentFromEvent(event);
    if (
      !entry ||
      !admitAfterTombstone(state.tombstones, entry.pubkey, entry.updatedAt)
    )
      return state;
    const registry = mergeAgentEntry(state.registry, entry);
    return registry === state.registry ? state : { ...state, registry };
  }
  if (event.kind !== 5) return state;
  let { registry, tombstones } = state;
  const prefix = `30177:${owner}:`;
  for (const tag of event.tags) {
    if (tag[0] !== "a" || !tag[1]?.startsWith(prefix)) continue;
    const pubkey = tag[1].slice(prefix.length);
    if (!/^[0-9a-f]{64}$/.test(pubkey)) continue;
    tombstones = applyTombstone(tombstones, pubkey, event.created_at);
    const entry = registry.get(pubkey);
    if (entry && entry.updatedAt <= event.created_at)
      registry = withoutKey(registry, pubkey);
  }
  return registry === state.registry && tombstones === state.tombstones
    ? state
    : { registry, tombstones };
}
