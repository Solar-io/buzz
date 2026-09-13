/**
 * Recipient suggestions for the New-DM dialog. Pure logic so the merge,
 * filter, and self-exclusion rules are testable without a relay.
 *
 * Sources: the owner's agent registry (kind 30177 — every registered agent)
 * plus the counterparties of the user's existing DMs. Registry entries win
 * dedupe so an agent is badged "Agent" even when it also has a DM history.
 * Registry pubkeys flagged stale (older duplicate of a re-minted name, or
 * unclaimed by any desktop catalog) are demoted: dead keys dead-letter DMs.
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
  /**
   * True for registry entries flagged stale (older duplicate of a re-minted
   * name, or unclaimed by any desktop catalog). Stale keys are dead — DMs
   * sent to them dead-letter — so they sort last and render demoted.
   */
  stale?: boolean;
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
 * - stale agents sort dead last, then agents before contacts, each group
 *   alphabetical by label.
 */
export function buildDmSuggestions({
  agents,
  contacts,
  profiles,
  selfPubkey,
  filter,
  stalePubkeys = new Set<string>(),
}: {
  agents: AgentRegistryEntry[];
  contacts: string[];
  profiles: Map<string, NameLikeProfile>;
  selfPubkey: string | null;
  filter: string;
  /** Registry pubkeys flagged stale (older duplicate / unclaimed). */
  stalePubkeys?: Set<string>;
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
      stale: stalePubkeys.has(agent.pubkey) || undefined,
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
        // Stale keys are dead last — a demoted registration must never
        // outrank a live contact, let alone a live agent.
        Number(Boolean(a.stale)) - Number(Boolean(b.stale)) ||
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

const HEX64 = /^[0-9a-fA-F]{64}$/;
// The bech32 prefix shape `parsePubkeyInput` treats as a key attempt (npub,
// nsec, note…). Mirrors the regex in dmInput.ts — kept in sync by its test.
const BECH32_LIKE = /^[a-z0-9]+1[02-9ac-hj-np-z]+$/;

/**
 * Turn free text someone typed into a suggestion, or null when nothing
 * conclusive matches.
 *
 * This is the fallback for text that failed `parsePubkeyInput` — the common
 * case being a display name typed into a field labelled "npub or 64-hex".
 * The caller passes the ALREADY-FILTERED suggestion list (buildDmSuggestions
 * with the text as filter), so "unique match" here means "the filter narrowed
 * to one". Resolution order:
 *
 * 1. an exact (case-insensitive) label match — typing "gilfoyle" with two
 *    partial matches present still means the one they spelled in full;
 * 2. otherwise, exactly one suggestion survived the filter.
 *
 * Key-shaped text returns null on purpose: a full key takes the parse path
 * before this runs, and anything key-SHAPED that failed parse (an nsec, a
 * truncated key) must surface the parser's specific error rather than
 * silently add a member whose hex happens to contain the substring.
 */
export function resolveSuggestionQuery(
  raw: string,
  suggestions: DmSuggestion[],
): DmSuggestion | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }
  const lowered = text.toLowerCase();
  if (HEX64.test(text) || BECH32_LIKE.test(lowered)) {
    return null;
  }
  const exact = suggestions.find((s) => s.label.toLowerCase() === lowered);
  if (exact) {
    return exact;
  }
  return suggestions.length === 1 ? suggestions[0] : null;
}
