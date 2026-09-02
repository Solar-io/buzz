/**
 * Recipient suggestions for the New-DM dialog. Pure logic so the merge,
 * filter, and self-exclusion rules are testable without a relay.
 *
 * Sources: the owner's agent registry (kind 30177 — every registered agent)
 * plus the counterparties of the user's existing DMs. Registry entries win
 * dedupe so an agent is badged "Agent" even when it also has a DM history.
 */

import type { AgentRegistryEntry } from "../../agents/lib/agentRegistry.ts";
import { truncatePubkey } from "../../../shared/lib/pubkey.ts";

export interface NameLikeProfile {
  name: string;
  displayName?: string;
}

export interface DmSuggestion {
  pubkey: string;
  /** Best display name available (profile > agent name > truncated key). */
  label: string;
  sublabel: "Agent" | "Contact";
}

export function profileLabel(
  pubkey: string,
  profiles: Map<string, NameLikeProfile>,
): string {
  const profile = profiles.get(pubkey);
  if (!profile) {
    return truncatePubkey(pubkey);
  }
  return profile.displayName || profile.name || truncatePubkey(pubkey);
}

/**
 * Build the selectable recipient list.
 *
 * - self is never suggested;
 * - an agent entry wins over a contact entry for the same pubkey;
 * - `filter` matches case-insensitively against the label OR the hex pubkey
 *   (so pasting part of a key still narrows), empty filter = all;
 * - agents sort before contacts, each group alphabetical by label.
 */
export function buildDmSuggestions({
  agents,
  contacts,
  profiles,
  selfPubkey,
  filter,
}: {
  agents: AgentRegistryEntry[];
  contacts: string[];
  profiles: Map<string, NameLikeProfile>;
  selfPubkey: string | null;
  filter: string;
}): DmSuggestion[] {
  const byPubkey = new Map<string, DmSuggestion>();
  for (const pubkey of contacts) {
    if (pubkey === selfPubkey) {
      continue;
    }
    byPubkey.set(pubkey, {
      pubkey,
      label: profileLabel(pubkey, profiles),
      sublabel: "Contact",
    });
  }
  for (const agent of agents) {
    if (agent.pubkey === selfPubkey) {
      continue;
    }
    // Registry name wins over the DM-derived profile label: it is the name
    // the owner configured and recognises.
    byPubkey.set(agent.pubkey, {
      pubkey: agent.pubkey,
      label: agent.name || profileLabel(agent.pubkey, profiles),
      sublabel: "Agent",
    });
  }

  const needle = filter.trim().toLowerCase();
  return Array.from(byPubkey.values())
    .filter(
      (suggestion) =>
        needle === "" ||
        suggestion.label.toLowerCase().includes(needle) ||
        suggestion.pubkey.toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        Number(a.sublabel === "Contact") - Number(b.sublabel === "Contact") ||
        a.label.localeCompare(b.label),
    );
}

/** Chip label for an already-selected recipient. */
export function recipientLabel(
  pubkey: string,
  suggestions: DmSuggestion[],
  profiles: Map<string, NameLikeProfile>,
): string {
  const suggestion = suggestions.find((s) => s.pubkey === pubkey);
  return suggestion?.label ?? profileLabel(pubkey, profiles);
}
