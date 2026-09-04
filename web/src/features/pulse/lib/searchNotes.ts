import type { PulseNote } from "./pulseTypes.ts";

/**
 * Client-side search over the notes already loaded into the Everyone feed.
 *
 * The desktop's Search tab is a decorative surface: its magnifier button has
 * no `onClick` and its input feeds nothing
 * (`desktop/src/features/pulse/ui/PulseView.tsx`, the `activeTab === "search"`
 * branch). Rather than port a dead control, the web filters the feed it
 * already holds — which is honest about its scope (it searches what is
 * loaded, not the relay's whole history) and can actually be verified.
 *
 * Matching is case-insensitive over the note body plus the author's display
 * name and pubkey, so "notes by X" and "notes mentioning Y" both work from
 * one field. Every whitespace-separated term must match somewhere (AND), so
 * adding a word narrows rather than widens.
 */
export function filterNotes(
  notes: readonly PulseNote[],
  query: string,
  authorNames: ReadonlyMap<string, string> = new Map(),
): PulseNote[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return [...notes];
  }
  return notes.filter((note) => {
    const haystack = [
      note.content,
      note.pubkey,
      authorNames.get(note.pubkey) ?? "",
    ]
      .join("\n")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
