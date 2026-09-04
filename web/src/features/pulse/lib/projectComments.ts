import { KIND_REPO_ANNOUNCEMENT, type PulseNote } from "./pulseTypes.ts";

const REPO_ADDRESS_PREFIX = `${KIND_REPO_ANNOUNCEMENT}:`;

/**
 * Project issue/PR comments are published as `kind:1` text notes (the relay
 * does not register NIP-22 `kind:1111`) tagged with the repo's NIP-34 address
 * (`a` = `30617:<owner>:<repo>`). Without this filter they bleed into Pulse
 * feeds as orphaned replies whose parent — a 1618/1621 git event, not a
 * `kind:1` note — can never be resolved.
 *
 * Ported from `desktop/src/features/pulse/lib/projectComments.ts`.
 */
export function isProjectComment(note: PulseNote): boolean {
  return note.tags.some(
    (tag) =>
      tag[0] === "a" && (tag[1]?.startsWith(REPO_ADDRESS_PREFIX) ?? false),
  );
}

/** Strip project issue/PR comments from a notes feed. */
export function withoutProjectComments(notes: PulseNote[]): PulseNote[] {
  return notes.filter((note) => !isProjectComment(note));
}
