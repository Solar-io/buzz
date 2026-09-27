/**
 * Owner-authored agent voice assignment (kind 30183) — the wire format,
 * mirroring the relay rather than guessed.
 *
 * Source of truth: `crates/buzz-core/src/kind.rs`
 * (`KIND_AGENT_VOICE_ASSIGNMENT = 30183`) and the relay's ingest:
 *
 *  - parameterized-replaceable, author = the agent's registered OWNER;
 *  - exactly one `d` tag = the agent pubkey, 64 lowercase hex — one row per
 *    (owner, agent);
 *  - content = the SAME selection body as kind:30182 (the relay reuses one
 *    validator), so `parseAgentVoiceContent` is shared, not copied;
 *  - the relay refuses the write unless `is_agent_owner(agent, author)`, so a
 *    stored row is already ownership-checked — readers trust the relay the
 *    same way they trust every other relay-validated kind;
 *  - clearing is a kind-5 `a`-tag coordinate delete of
 *    `30183:<owner>:<agent>` (the CLI's `buzz voices assign --clear`).
 *
 * Import-free apart from sibling pure modules, so `node --test` loads it.
 */

import {
  parseAgentVoiceContent,
  type AgentVoiceEventLike,
  type AgentVoiceSelection,
} from "./agentVoiceSelection.ts";

/** Owner voice assignment. `crates/buzz-core/src/kind.rs`. */
export const KIND_AGENT_VOICE_ASSIGNMENT = 30183;

/** NIP-09 deletion — how an assignment is cleared. */
export const KIND_DELETION = 5;

/** One validated assignment with its provenance. */
export interface AgentVoiceAssignmentRow {
  /** The agent the assignment is for (the `d` tag), lowercase hex. */
  agentPubkey: string;
  /** The owner who signed it (event author). */
  ownerPubkey: string;
  createdAt: number;
  selection: AgentVoiceSelection;
  label: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The NIP-33 coordinate of one (owner, agent) assignment. */
export function assignmentCoordinate(
  ownerPubkey: string,
  agentPubkey: string,
): string {
  return `${KIND_AGENT_VOICE_ASSIGNMENT}:${ownerPubkey.toLowerCase()}:${agentPubkey.toLowerCase()}`;
}

/**
 * Read one kind:30183 event, or `null` for anything the relay would refuse:
 * not exactly one `d` tag, a `d` that is not 64 lowercase hex, or a body the
 * shared selection grammar rejects.
 */
export function parseAgentVoiceAssignmentEvent(
  event: AgentVoiceEventLike,
): AgentVoiceAssignmentRow | null {
  const dTags = event.tags.filter(
    (tag) => Array.isArray(tag) && tag[0] === "d" && typeof tag[1] === "string",
  );
  if (dTags.length !== 1) {
    return null;
  }
  const agentPubkey = dTags[0][1];
  if (!HEX64.test(agentPubkey)) {
    return null;
  }
  const parsed = parseAgentVoiceContent(event.content);
  if (parsed === null) {
    return null;
  }
  return {
    agentPubkey,
    ownerPubkey: event.pubkey.toLowerCase(),
    createdAt: event.created_at,
    selection: parsed.selection,
    label: parsed.label,
  };
}

/** A kind-5 event, as far as the fold reads it. */
interface DeletionLike extends AgentVoiceEventLike {
  kind?: number;
}

/**
 * Fold assignment events (and kind-5 coordinate deletes of them) into one
 * row per AGENT pubkey.
 *
 * Keyed by agent, not by (owner, agent): an agent has one registered owner,
 * and the relay refuses a 30183 from anyone else — so two owners' rows for
 * one agent cannot both be valid. Newest `created_at` wins. A deletion
 * signed by the row's owner at or after the row's `created_at` removes it
 * (NIP-09 semantics: a delete never removes a NEWER replacement).
 */
export function reduceAgentVoiceAssignmentEvents(
  events: readonly DeletionLike[],
): Map<string, AgentVoiceAssignmentRow> {
  const rows = new Map<string, AgentVoiceAssignmentRow>();
  const deletions: DeletionLike[] = [];
  for (const event of events) {
    if (event.kind === KIND_DELETION) {
      deletions.push(event);
      continue;
    }
    const row = parseAgentVoiceAssignmentEvent(event);
    if (row === null) {
      continue;
    }
    const existing = rows.get(row.agentPubkey);
    if (existing && existing.createdAt >= row.createdAt) {
      continue;
    }
    rows.set(row.agentPubkey, row);
  }
  for (const deletion of deletions) {
    for (const tag of deletion.tags) {
      if (tag[0] !== "a" || typeof tag[1] !== "string") {
        continue;
      }
      const [kind, owner, agent] = tag[1].split(":");
      if (kind !== String(KIND_AGENT_VOICE_ASSIGNMENT) || !agent) {
        continue;
      }
      const row = rows.get(agent);
      if (
        row &&
        row.ownerPubkey === owner &&
        owner === deletion.pubkey.toLowerCase() &&
        deletion.created_at >= row.createdAt
      ) {
        rows.delete(agent);
      }
    }
  }
  return rows;
}
