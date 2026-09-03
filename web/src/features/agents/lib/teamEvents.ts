import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Kind-30176 team-event reader — the web mirror of the desktop's
 * `desktop/src-tauri/src/managed_agents/team_events.rs` wire semantics.
 * Teams are NIP-33 parameterized replaceable events keyed by
 * `(pubkey, kind, d_tag)` where `d_tag` is the team's stable id, published
 * through the same retention flush loop as personas. Pure parse + merge,
 * React-free for the node runner.
 *
 * THE TRI-STATES (permanent wire semantics, not shims — team_events.rs doc
 * comments, born of the Sietch Tabr membership-wipe incident):
 * - `persona_ids` ABSENT = the publisher predates always-publish: its true
 *   membership is UNKNOWN. The web has no local record to preserve, so it
 *   treats the list as empty BUT FLAGS it `membershipUnknown` — the panel
 *   must never present "0 members" as a fact for such a team. `[]` is the
 *   explicit "no members" signal.
 * - `instructions` absent or `null` = no instructions to show; a string =
 *   set. (The Rust reconcile preserves local state on absent; a read-only
 *   web view has nothing to preserve, so absent and null collapse here —
 *   both render "no instructions", never a fabricated one.)
 *
 * Read scope note: 30176 is deliberately NOT shared-gated (kind.rs: the
 * acknowledged relay gap). The web subscribes author-scoped only
 * (useTeams), which is correct today and survives any future
 * owner-private read tightening. Community team browsing is NOT built.
 */

export const TEAM_KIND = 30176;

/** The read-only team projection the web panels render. */
export interface TeamView {
  /** Team id — the event's d tag (stable across replaces). */
  id: string;
  name: string;
  description: string | null;
  /** Absent and null both collapse to null (see file doc comment). */
  instructions: string | null;
  /** True when `persona_ids` was absent — membership unknown, not empty. */
  membershipUnknown: boolean;
  personaIds: string[];
  /** Event created_at — the merge key for replaceable updates. */
  updatedAt: number;
  /** Event id — the tie-break for mergeTeam (lower id wins a timestamp tie). */
  eventId: string;
}

/** Parse one 30176 team event; null for wrong-shape events. */
export function teamFromEvent(event: SignedNostrEvent): TeamView | null {
  if (event.kind !== TEAM_KIND) {
    return null;
  }
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (typeof dTag !== "string" || dTag.length === 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  // `name` is a required String in TeamEventContent — a missing or non-string
  // name is a malformed event the desktop's serde would reject outright.
  if (typeof object.name !== "string" || object.name.trim() === "") {
    return null;
  }
  const membershipUnknown = object.persona_ids === undefined;
  const personaIds = Array.isArray(object.persona_ids)
    ? object.persona_ids.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return {
    id: dTag,
    name: object.name,
    description:
      typeof object.description === "string" ? object.description : null,
    instructions:
      typeof object.instructions === "string" ? object.instructions : null,
    membershipUnknown,
    personaIds,
    updatedAt: event.created_at,
    eventId: event.id,
  };
}

/**
 * Newest-wins merge into a team map (replaceable coordinate = id). A
 * timestamp tie resolves to the LOWER event id — the same tie-break the
 * persona catalog head selection uses, so the two replaceable-event readers
 * on this screen cannot disagree about which of two same-second publishes
 * is the head.
 */
export function mergeTeam(
  teams: ReadonlyMap<string, TeamView>,
  team: TeamView,
): Map<string, TeamView> {
  const existing = teams.get(team.id);
  if (existing) {
    const existingWins =
      existing.updatedAt > team.updatedAt ||
      (existing.updatedAt === team.updatedAt &&
        existing.eventId <= team.eventId);
    if (existingWins) {
      return teams as Map<string, TeamView>;
    }
  }
  const next = new Map(teams);
  next.set(team.id, team);
  return next;
}
