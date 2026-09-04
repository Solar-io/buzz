/**
 * Highlighting and excerpting for search results.
 *
 * Ported from the desktop's `search/lib/searchMatch.ts`, and it matches on
 * **lexemes**, not raw substrings, because that is what the relay's Postgres
 * FTS did to produce the hit: the `simple` configuration splits on
 * punctuation, so `foo-bar` contributes `foo` and `bar`. Highlighting raw
 * substrings would mark text the relay never matched (and miss text it did).
 *
 * Only the trailing whitespace-delimited token is treated as a *prefix* — the
 * same asymmetry as the query the relay ran (`foo bar:*`), so a completed word
 * highlights exactly and the word being typed highlights as far as it goes.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export interface SearchMatchPart {
  isMatch: boolean;
  key: string;
  text: string;
}

interface Matcher {
  isPrefix: boolean;
  value: string;
}

interface Lexeme {
  start: number;
  end: number;
  normalized: string;
}

const LEXEME_PATTERN = /[\p{L}\p{N}]+/gu;

function lexemesOf(value: string): Lexeme[] {
  return Array.from(value.matchAll(LEXEME_PATTERN), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    normalized: match[0].toLowerCase(),
  }));
}

function matchersFor(query: string): Matcher[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const matchers: Matcher[] = [];
  tokens.forEach((token, index) => {
    const isPrefix = index === tokens.length - 1;
    for (const lexeme of lexemesOf(token)) {
      matchers.push({ isPrefix, value: lexeme.normalized });
    }
  });
  // Deduplicate without collapsing exact and prefix modes: `foo foo` asks for
  // both an exact `foo` and a `foo:*`.
  const deduped = new Map<string, Matcher>();
  for (const matcher of matchers) {
    deduped.set(`${matcher.isPrefix ? "p" : "e"}:${matcher.value}`, matcher);
  }
  // Longest first, so a long term wins the span over a short one it contains.
  return [...deduped.values()].sort(
    (left, right) => right.value.length - left.value.length,
  );
}

/** Lexemes the query would have asked Postgres for. */
export function searchHighlightTerms(query: string): string[] {
  return matchersFor(query).map((matcher) => matcher.value);
}

function matchSpans(
  text: string,
  query: string,
): Array<{ start: number; end: number }> {
  const matchers = matchersFor(query);
  if (matchers.length === 0) {
    return [];
  }
  const spans: Array<{ start: number; end: number }> = [];
  for (const lexeme of lexemesOf(text)) {
    const exact = matchers.find(
      (matcher) => !matcher.isPrefix && matcher.value === lexeme.normalized,
    );
    if (exact) {
      spans.push({ start: lexeme.start, end: lexeme.end });
      continue;
    }
    const prefix = matchers.find(
      (matcher) =>
        matcher.isPrefix && lexeme.normalized.startsWith(matcher.value),
    );
    if (prefix) {
      spans.push({
        start: lexeme.start,
        end: lexeme.start + prefix.value.length,
      });
    }
  }
  return spans;
}

/** Split `text` into matched and unmatched runs, in order. */
export function splitSearchMatches(
  text: string,
  query: string,
): SearchMatchPart[] {
  const spans = matchSpans(text, query);
  if (spans.length === 0) {
    return [{ isMatch: false, key: "0", text }];
  }
  const parts: SearchMatchPart[] = [];
  let offset = 0;
  for (const span of spans) {
    if (span.start > offset) {
      parts.push({
        isMatch: false,
        key: `t${offset}`,
        text: text.slice(offset, span.start),
      });
    }
    parts.push({
      isMatch: true,
      key: `m${span.start}`,
      text: text.slice(span.start, span.end),
    });
    offset = span.end;
  }
  if (offset < text.length) {
    parts.push({ isMatch: false, key: `t${offset}`, text: text.slice(offset) });
  }
  return parts;
}

/**
 * A one-line excerpt that keeps the first match visible.
 *
 * Context is biased *before* the match so the excerpt still reads like a
 * sentence, while never clipping the matched word off the right edge — which
 * is what a naive `slice(0, n)` does to a hit near the end of a long message.
 */
export function searchResultPreview(
  content: string,
  query: string,
  maxLength = 120,
): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return "No message body.";
  }
  if (text.length <= maxLength) {
    return text;
  }
  const matchIndex = matchSpans(text, query)[0]?.start ?? -1;
  if (matchIndex < 0) {
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }
  const contextBefore = Math.min(32, Math.floor(maxLength / 3));
  let start = Math.max(0, matchIndex - contextBefore);
  const end = Math.min(text.length, start + maxLength);
  if (end === text.length) {
    start = Math.max(0, end - maxLength);
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const available = Math.max(0, maxLength - prefix.length - suffix.length);
  return `${prefix}${text.slice(start, start + available).trim()}${suffix}`;
}
