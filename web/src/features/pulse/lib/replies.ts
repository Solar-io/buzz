import type { PulseNote } from "./pulseTypes.ts";

/**
 * The note this one replies to, under NIP-10's marked scheme with the
 * deprecated positional scheme as a fallback.
 *
 * Preference order, all scanning from the LAST `e` tag backwards (the newest
 * reference wins): an explicit `reply` marker, then an unmarked tag, then
 * `root`. A thread whose only reference is `root` is a direct reply to the
 * root, so returning it there is correct rather than a guess.
 *
 * Ported from `desktop/src/features/pulse/lib/replies.ts`.
 */
export function getReplyParent(note: PulseNote): string | null {
  const eTags = note.tags.filter((tag) => tag[0] === "e" && tag[1]);

  for (const marker of ["reply", undefined, "root"] as const) {
    for (let index = eTags.length - 1; index >= 0; index -= 1) {
      const tag = eTags[index];
      const matches = marker === undefined ? tag[3] == null : tag[3] === marker;
      if (matches) {
        return tag[1] ?? null;
      }
    }
  }

  return null;
}

/** A one-line, whitespace-collapsed preview of a note. */
export function noteSnippet(content: string, max = 120): string {
  return content.trim().replace(/\s+/g, " ").slice(0, max);
}
