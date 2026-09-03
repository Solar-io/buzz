/**
 * Mention tokenizing for the composer. Mirrors the CLI's semantics:
 * @Name tokens inside CODE REGIONS do not mention (no code-region stripping
 * server-side — the relay counts p tags only, so this is a UI concern: which
 * tokens to offer, highlight, and emit as p tags).
 */

export interface MentionToken {
  /** The text after @, e.g. "Sam" in "hi @Sam!". */
  name: string;
  /** Character index of the @ in the source string. */
  at: number;
}

/** Split out fenced and inline code spans so mentions ignore them. */
function maskCodeRegions(text: string): string {
  const masked = text.split("```");
  for (let i = 1; i < masked.length; i += 2) {
    masked[i] = " ".repeat(masked[i].length);
  }
  let joined = masked.join("```");
  joined = joined.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
  return joined;
}

const NAME_SOURCE = /[A-Za-z0-9_.-]/;

export function extractMentionTokens(text: string): MentionToken[] {
  const masked = maskCodeRegions(text);
  const tokens: MentionToken[] = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] === "@") {
      let end = i + 1;
      while (end < masked.length && NAME_SOURCE.test(masked[end])) {
        end += 1;
      }
      if (end > i + 1) {
        tokens.push({ name: text.slice(i + 1, end), at: i });
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return tokens;
}

/**
 * A mention the author picked from the autocomplete, remembered by the name
 * that was inserted. Keys are lowercased so lookup matches the token compare.
 */
export type MentionPicks = ReadonlyMap<string, string>;

/**
 * Resolve @Name tokens against channel members. Unique matches become
 * p-tags; ambiguous or unknown names are left alone (the caller decides
 * whether to block sending, matching the CLI's explicit-mention contract).
 *
 * `picks` carries the pubkeys the author chose from the autocomplete. They win
 * over name matching, which is what makes two members sharing a display name
 * distinguishable: without a pick, "@Sam" is ambiguous and correctly resolves
 * to nothing, but a picked "@Sam" carries the pubkey the author actually
 * clicked. Names typed by hand still fall back to member matching.
 *
 * A pick keeps applying while its name is still in the text, so deleting a
 * picked mention and retyping the same name reuses that pubkey. That is the
 * intended "last pick wins" behaviour; the alternative — silently dropping to
 * ambiguity on an edit — is harder to explain and easier to get wrong.
 */
export function resolveMentions(
  text: string,
  members: { pubkey: string; name: string }[],
  picks?: MentionPicks,
): {
  mentionPubkeys: string[];
  unresolved: string[];
} {
  const byLower = new Map<string, string[]>();
  for (const member of members) {
    const key = member.name.trim().toLowerCase();
    const list = byLower.get(key) ?? [];
    list.push(member.pubkey);
    byLower.set(key, list);
  }
  const mentionPubkeys: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const add = (pubkey: string) => {
    if (!seen.has(pubkey)) {
      seen.add(pubkey);
      mentionPubkeys.push(pubkey);
    }
  };
  for (const token of extractMentionTokens(text)) {
    const lower = token.name.toLowerCase();
    const picked = picks?.get(lower);
    if (picked) {
      add(picked);
      continue;
    }
    const matches = byLower.get(lower);
    if (!matches) {
      unresolved.push(token.name);
      continue;
    }
    if (matches.length > 1) {
      unresolved.push(token.name);
      continue;
    }
    add(matches[0]);
  }
  return { mentionPubkeys, unresolved };
}

/** The token being typed at the caret, if any — drives the autocomplete. */
export function activeMentionQuery(
  text: string,
  caretIndex: number,
): string | null {
  const upToCaret = text.slice(0, caretIndex);
  const match = /(^|\s)@([A-Za-z0-9_.-]*)$/.exec(upToCaret);
  return match ? match[2] : null;
}
