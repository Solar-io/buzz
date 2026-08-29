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
 * Resolve @Name tokens against channel members. Unique matches become
 * p-tags; ambiguous or unknown names are left alone (the caller decides
 * whether to block sending, matching the CLI's explicit-mention contract).
 */
export function resolveMentions(
  text: string,
  members: { pubkey: string; name: string }[],
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
  for (const token of extractMentionTokens(text)) {
    const matches = byLower.get(token.name.toLowerCase());
    if (!matches) {
      unresolved.push(token.name);
      continue;
    }
    if (matches.length > 1) {
      unresolved.push(token.name);
      continue;
    }
    const [pubkey] = matches;
    if (!seen.has(pubkey)) {
      seen.add(pubkey);
      mentionPubkeys.push(pubkey);
    }
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
