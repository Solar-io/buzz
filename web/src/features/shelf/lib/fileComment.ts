/**
 * A comment on a file is an ordinary thread reply (phase-6 "Comments"). One
 * written "on a highlight" — text selected in the preview first — carries
 * that text as a leading markdown quote, so every client (and the agent that
 * shared the file) reads it as "about this part":
 *
 *     > Top effort decided both creative rounds
 *
 *     Re-run C with audio on before 10/8.
 *
 * Pure so `node --test` loads it directly.
 */

/** Longest highlight a comment quotes; the rest is "…". */
export const MAX_QUOTE_CHARS = 280;

/** The selection, tidied into one quotable line (or null if empty). */
export function cleanQuote(selection: string): string | null {
  const text = selection.replace(/\s+/g, " ").trim();
  if (text === "") {
    return null;
  }
  return text.length > MAX_QUOTE_CHARS
    ? `${text.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`
    : text;
}

export function quotedComment(quote: string | null, body: string): string {
  const text = body.trim();
  if (quote === null) {
    return text;
  }
  return `> ${quote}\n\n${text}`;
}

/** Split a comment back into its highlight and its words. */
export function splitQuotedComment(content: string): {
  quote: string | null;
  body: string;
} {
  const lines = content.split("\n");
  const quoted: string[] = [];
  let index = 0;
  while (index < lines.length && /^>\s?/.test(lines[index])) {
    quoted.push(lines[index].replace(/^>\s?/, ""));
    index += 1;
  }
  if (quoted.length === 0) {
    return { quote: null, body: content.trim() };
  }
  const body = lines.slice(index).join("\n").trim();
  const quote = quoted.join(" ").trim();
  // A comment that is ONLY a quote is a quote, not a highlight note.
  if (body === "" || quote === "") {
    return { quote: null, body: content.trim() };
  }
  return { quote, body };
}

export interface CommentNode<T> {
  comment: T;
  replies: T[];
}

/**
 * Comments as the pane shows them: top-level notes in time order, each with
 * the replies made TO it folded under it (an agent answering a note). A reply
 * to a reply folds into the same note, so the pane never nests twice.
 */
export function commentTree<
  T extends { id: string; replyToId: string | null; createdAt: number },
>(comments: readonly T[]): CommentNode<T>[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const topOf = (comment: T): T => {
    let current = comment;
    const seen = new Set<string>();
    while (current.replyToId && byId.has(current.replyToId)) {
      if (seen.has(current.id)) {
        break;
      }
      seen.add(current.id);
      current = byId.get(current.replyToId) as T;
    }
    return current;
  };
  const nodes = new Map<string, CommentNode<T>>();
  const ordered = [...comments].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  for (const comment of ordered) {
    const top = topOf(comment);
    if (top.id === comment.id) {
      nodes.set(comment.id, { comment, replies: [] });
    }
  }
  for (const comment of ordered) {
    const top = topOf(comment);
    if (top.id !== comment.id) {
      nodes.get(top.id)?.replies.push(comment);
    }
  }
  return [...nodes.values()];
}
