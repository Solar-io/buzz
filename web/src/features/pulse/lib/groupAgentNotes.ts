import type { PulseNote } from "./pulseTypes.ts";

/** A run of consecutive notes from one agent inside a time window. */
export interface AgentNoteGroup {
  /** Agent pubkey. */
  pubkey: string;
  /** The notes in this group, newest first. */
  notes: PulseNote[];
  /** `createdAt` of the newest note in the group. */
  latestAt: number;
  /** `createdAt` of the oldest note in the group. */
  earliestAt: number;
}

/** Default grouping window: five minutes of agent chatter reads as one burst. */
export const AGENT_GROUP_WINDOW_SECONDS = 300;

/**
 * Group notes by agent pubkey + time proximity, so a burst of agent output
 * collapses into one card instead of ten rows.
 *
 * Input MUST be sorted newest-first. Consecutive notes from the same author
 * join the current group as long as the gap to the PREVIOUS note in that group
 * is within `windowSeconds` — compared against the previous note rather than
 * the group's earliest, which would let one group grow without bound.
 *
 * Ported from `desktop/src/features/pulse/lib/groupAgentNotes.ts`.
 */
export function groupAgentNotes(
  notes: PulseNote[],
  windowSeconds = AGENT_GROUP_WINDOW_SECONDS,
): AgentNoteGroup[] {
  if (notes.length === 0) {
    return [];
  }

  const groups: AgentNoteGroup[] = [];
  let current: AgentNoteGroup | null = null;

  for (const note of notes) {
    const lastNoteInGroup = current?.notes[current.notes.length - 1];
    if (
      current &&
      lastNoteInGroup &&
      current.pubkey === note.pubkey &&
      lastNoteInGroup.createdAt - note.createdAt <= windowSeconds
    ) {
      current.notes.push(note);
      current.earliestAt = note.createdAt;
      continue;
    }
    if (current) {
      groups.push(current);
    }
    current = {
      pubkey: note.pubkey,
      notes: [note],
      latestAt: note.createdAt,
      earliestAt: note.createdAt,
    };
  }

  if (current) {
    groups.push(current);
  }
  return groups;
}
