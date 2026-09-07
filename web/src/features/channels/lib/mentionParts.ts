import {
  EVERYONE,
  extractMentionTokens,
  isEveryoneMention,
  longestMentionMatch,
} from "./mentions.ts";

export type MentionPart =
  | { kind: "text"; text: string; key: string }
  | { kind: "mention"; text: string; key: string };

/**
 * Split a text node into plain-text and @mention parts.
 *
 * Matching is the SAME machinery the composer's resolver uses — spans from
 * extractMentionTokens, the longest boundary-matching known name from
 * longestMentionMatch — so a tagged "@Crash Override" highlights whole and
 * the two sides cannot drift apart again (the resolver was fixed to
 * multi-word names on 2026-09-06 while this renderer still tokenized one
 * word, and correctly-pinging mentions rendered without the highlight).
 *
 * `names` is the event's p-tag display names (lowercased by the call sites);
 * a mention is highlighted only when one of them matches. "@everyone"
 * highlights whenever the token is present and the event carries any p tags
 * at all — an @everyone send p-tags every member, and the composer reserves
 * the token, so its presence in a mention-carrying body means it.
 *
 * Returns null when nothing is a mention so callers keep the original node.
 */
export function mentionParts(
  text: string,
  names: ReadonlySet<string>,
): MentionPart[] | null {
  if (names.size === 0) {
    return null;
  }
  const parts: MentionPart[] = [];
  let last = 0;
  for (const token of extractMentionTokens(text)) {
    const matched = isEveryoneMention(text, token.at)
      ? EVERYONE
      : longestMentionMatch(text, token.at, names);
    if (matched === null) {
      continue;
    }
    const end = token.at + 1 + matched.length;
    if (token.at > last) {
      parts.push({
        kind: "text",
        text: text.slice(last, token.at),
        key: `t${parts.length}`,
      });
    }
    parts.push({
      kind: "mention",
      text: text.slice(token.at, end),
      key: `m${parts.length}`,
    });
    last = end;
  }
  if (parts.length === 0) {
    return null;
  }
  if (last < text.length) {
    parts.push({
      kind: "text",
      text: text.slice(last),
      key: `t${parts.length}`,
    });
  }
  return parts;
}
