export type MentionPart =
  | { kind: "text"; text: string; key: string }
  | { kind: "mention"; text: string; key: string };

/**
 * Split a text node into plain-text and @mention parts.
 *
 * The scan execs one /g regex over the WHOLE string, so exec advances
 * lastIndex on every iteration and non-matching tokens can safely
 * `continue`. (The previous implementation re-exec'd a suffix slice and
 * skipped the re-exec on non-matching tokens — a synchronous infinite
 * loop that froze the renderer on any message containing an @token that
 * wasn't a p-tagged mention, live incident 2026-08-29.)
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
  const pattern = /@([A-Za-z0-9_.-]+)/g;
  const parts: MentionPart[] = [];
  let last = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) {
      break;
    }
    const name = match[1];
    if (!names.has(name.toLowerCase())) {
      continue;
    }
    if (match.index > last) {
      parts.push({
        kind: "text",
        text: text.slice(last, match.index),
        key: `t${parts.length}`,
      });
    }
    parts.push({ kind: "mention", text: match[0], key: `m${parts.length}` });
    last = match.index + match[0].length;
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
