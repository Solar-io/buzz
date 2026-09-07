/**
 * Mention tokenizing for the composer. Mirrors the CLI's semantics:
 * @Name tokens inside CODE REGIONS do not mention (no code-region stripping
 * server-side — the relay counts p tags only, so this is a UI concern: which
 * tokens to offer, highlight, and emit as p tags).
 *
 * A token is a SPAN: name characters joined by SINGLE spaces, so multi-word
 * display names ("Lord Nikon") tokenize whole. Double spaces end a span, and
 * masked code regions can never extend one (they mask to runs of two or more
 * spaces / backticks). Prose words after a completed mention glom onto the
 * span ("@Sam and") — harmless, because resolution takes the longest KNOWN
 * name inside the span, never the span itself.
 */

export interface MentionToken {
  /** The text after @, e.g. "Sam" in "hi @Sam!", "Lord Nikon" in "@Lord Nikon!". */
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

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && NAME_SOURCE.test(ch);
}

/** Maximal run of name chars joined by single spaces, starting at `from`. */
function scanMentionSpan(masked: string, from: number): number {
  let end = from;
  while (isNameChar(masked[end])) {
    end += 1;
  }
  if (end === from) {
    return from;
  }
  // A single space continues the span only when a name char follows; a double
  // space (or any other character) ends it.
  while (masked[end] === " " && isNameChar(masked[end + 1])) {
    end += 1;
    while (isNameChar(masked[end])) {
      end += 1;
    }
  }
  return end;
}

export function extractMentionTokens(text: string): MentionToken[] {
  const masked = maskCodeRegions(text);
  const tokens: MentionToken[] = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] === "@") {
      const end = scanMentionSpan(masked, i + 1);
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

/** The reserved expansion token: everyone in the channel except the author. */
export const EVERYONE = "everyone";

function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when a candidate name would legally end there: EOL, whitespace, or a non-name char. */
function endsOnBoundary(masked: string, index: number): boolean {
  const ch = masked[index];
  return ch === undefined || /\s/.test(ch) || !NAME_SOURCE.test(ch);
}

/**
 * The longest known name matching at an @ position, or null when nothing
 * known boundary-matches there. THE matcher for mention semantics — the
 * composer's resolver AND the message renderer both call it, so matching
 * fixes cannot land in one and skip the other (which is exactly how
 * multi-word names shipped broken: resolver and renderer tokenized
 * differently). `names` are display names in any case; they are normalized
 * before matching, and the match never crosses a code region.
 */
export function longestMentionMatch(
  text: string,
  at: number,
  names: Iterable<string>,
): string | null {
  const masked = maskCodeRegions(text);
  const maskedLower = masked.toLowerCase();
  let best: string | null = null;
  for (const raw of names) {
    const candidate = normalizeName(raw);
    if (!candidate || candidate.length <= (best?.length ?? 0)) {
      continue;
    }
    if (!maskedLower.startsWith(candidate, at + 1)) {
      continue;
    }
    if (!endsOnBoundary(masked, at + 1 + candidate.length)) {
      continue;
    }
    best = candidate;
  }
  return best;
}

/**
 * True when the reserved @everyone token sits (boundary-delimited) at this
 * @: following prose does not defeat it, a run-on word does. Shared by the
 * resolver (which expands it) and the renderer (which highlights it).
 */
export function isEveryoneMention(text: string, at: number): boolean {
  const masked = maskCodeRegions(text);
  return (
    masked.toLowerCase().startsWith(EVERYONE, at + 1) &&
    endsOnBoundary(masked, at + 1 + EVERYONE.length)
  );
}

/**
 * Resolve @Name tokens against channel members. Unique matches become
 * p-tags; ambiguous or unknown names are left alone (the caller decides
 * whether to block sending, matching the CLI's explicit-mention contract).
 *
 * Resolution matches by the LONGEST KNOWN NAME at each @ — member names and
 * pick keys together, mirroring the desktop's extractMentionPubkeys — so a
 * member named "Sam" does not swallow a mention of "Sam Smith", and the
 * candidate must end on a boundary ("@Sam Smithson" is not "Sam Smith" run
 * together). This is what makes multi-word display names ("Crash Override")
 * tag: the span they tokenize into is matched as one name.
 *
 * `picks` carries the pubkeys the author chose from the autocomplete. On an
 * equal-length match a pick wins over name matching, which is what makes two
 * members sharing a display name distinguishable: without a pick, "@Sam" is
 * ambiguous and correctly resolves to nothing, but a picked "@Sam" carries
 * the pubkey the author actually clicked. Names typed by hand still fall
 * back to member matching.
 *
 * A pick keeps applying while its name is still in the text, so deleting a
 * picked mention and retyping the same name reuses that pubkey. That is the
 * intended "last pick wins" behaviour; the alternative — silently dropping to
 * ambiguity on an edit — is harder to explain and easier to get wrong.
 *
 * `@everyone` (exact, boundary-delimited) expands to every member's pubkey
 * except `selfPubkey`, the author's own. Without a self key the degenerate
 * case still holds: all members, unfiltered.
 */
export function resolveMentions(
  text: string,
  members: { pubkey: string; name: string }[],
  picks?: MentionPicks,
  selfPubkey?: string,
): {
  mentionPubkeys: string[];
  unresolved: string[];
} {
  const byLower = new Map<string, string[]>();
  for (const member of members) {
    const key = normalizeName(member.name);
    if (!key) {
      continue;
    }
    const list = byLower.get(key) ?? [];
    list.push(member.pubkey);
    byLower.set(key, list);
  }
  const pickByKey = new Map<string, string>();
  if (picks) {
    for (const [name, pubkey] of picks) {
      const key = normalizeName(name);
      if (key) {
        pickByKey.set(key, pubkey);
      }
    }
  }
  const candidates = [...new Set([...byLower.keys(), ...pickByKey.keys()])];

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
    // The reserved @everyone: boundary-delimited, so following prose does not
    // defeat it ("@everyone stand up" still fires) but a run-on word does
    // ("@everyones" does not).
    if (isEveryoneMention(text, token.at)) {
      for (const member of members) {
        if (member.pubkey !== selfPubkey) {
          add(member.pubkey);
        }
      }
      continue;
    }
    // Longest known name that prefixes the span and ends on a boundary (the
    // same matcher the renderer highlights with — see longestMentionMatch).
    const best = longestMentionMatch(text, token.at, candidates);
    if (best === null) {
      unresolved.push(token.name);
      continue;
    }
    const picked = pickByKey.get(best);
    if (picked !== undefined) {
      add(picked);
      continue;
    }
    const matches = byLower.get(best);
    if (!matches || matches.length > 1) {
      // Report the matched NAME, not the span — the span gloms trailing
      // prose ("@Crash Override you in?"), the ambiguity is about the name.
      unresolved.push(text.slice(token.at + 1, token.at + 1 + best.length));
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
  // The query spans single spaces so the popup survives typing the middle of
  // a multi-word name; the substring filter empties (and so closes it) as
  // soon as the accumulated text stops matching any known name.
  const match = /(^|\s)@([A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*)$/.exec(
    upToCaret,
  );
  return match ? match[2] : null;
}
