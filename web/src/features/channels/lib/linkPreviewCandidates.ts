/**
 * Which URLs in a draft message get a preview.
 *
 * Deliberately narrow. Every candidate becomes an outbound fetch the relay
 * performs on the sender's behalf, so this errs towards fewer: only bare
 * `https://` URLs in ordinary prose, capped, deduped, and never anything the
 * author has visibly marked as code.
 *
 * The href must survive into the sent message byte-for-byte — ingest requires
 * the snapshot's canonical URL to appear in the content — so the extracted
 * string is the exact substring found, with only trailing punctuation that
 * plainly belongs to the sentence removed.
 */

/** Never unfurl more than this many links from one message. */
export const MAX_CANDIDATES = 4;

/** Trailing characters that are almost always sentence punctuation. */
const TRAILING = ".,;:!?'\"";

/**
 * Strip fenced and inline code so a URL inside backticks is left alone.
 *
 * Replaced with spaces rather than removed, so offsets — and therefore the
 * "does the content contain this href" property — are unaffected for the
 * remaining text.
 */
function blankCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

/** Balance-aware trailing trim: `(see https://x.com/a)` keeps `/a`. */
function trimTrailing(raw: string): string {
  let url = raw;
  for (;;) {
    if (url.length === 0) {
      return url;
    }
    const last = url[url.length - 1];
    if (TRAILING.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

/**
 * The https URLs in `content` that should be offered a preview, in the order
 * they appear, deduped, capped at [`MAX_CANDIDATES`].
 *
 * http:// is excluded on purpose: the relay refuses it (previews must be
 * https), so offering one would only produce a failure the author cannot act
 * on.
 */
export function linkPreviewCandidates(content: string): string[] {
  const text = blankCode(content);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/https:\/\/[^\s<>"'`\\]+/g)) {
    const url = trimTrailing(match[0]);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.hostname === "") {
      continue;
    }
    // A URL that would not survive the message intact cannot be previewed:
    // the tag's canonical URL has to appear verbatim in the content.
    if (!content.includes(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    found.push(url);
    if (found.length >= MAX_CANDIDATES) {
      break;
    }
  }
  return found;
}
