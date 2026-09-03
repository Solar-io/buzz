/**
 * One-line excerpt of the message a reply is aimed at, for the composer's
 * reply banner.
 *
 * The desktop banner shows `Replying to <author>` over a truncated body
 * (`ComposerReplyEditBanner.tsx`). Raw markdown reads badly on one line, so
 * the syntax that carries no information at a glance is stripped: attachment
 * embeds become a short placeholder, code fences and inline backticks lose
 * their markers, links keep their label, and emphasis markers are dropped.
 * Nothing here changes the stored message — this is display only.
 */

const MAX_EXCERPT = 140;

/** Markdown image/video embeds, which are the attachment lines. */
const EMBED_RE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
/** Inline links — keep the label, drop the target. */
const LINK_RE = /\[([^\]\n]*)\]\([^)\n]*\)/g;
/** Fence lines, with or without an info string. */
const FENCE_RE = /```[^\n]*/g;
/** Emphasis / strike / spoiler markers. */
const MARKER_RE = /(\*\*|~~|\|\||[*_`>])/g;

export function replyExcerpt(
  content: string,
  maxLength: number = MAX_EXCERPT,
): string {
  const withoutEmbeds = content
    .replace(EMBED_RE, " 📎 attachment ")
    .replace(LINK_RE, "$1")
    .replace(FENCE_RE, " ")
    .replace(MARKER_RE, "");
  const collapsed = withoutEmbeds.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  // Cut on a word boundary when one is close to the limit, so the excerpt
  // does not end mid-word for the sake of two characters.
  const hardCut = collapsed.slice(0, maxLength);
  const lastSpace = hardCut.lastIndexOf(" ");
  const cut =
    lastSpace > maxLength - 20 ? hardCut.slice(0, lastSpace) : hardCut;
  return `${cut.trimEnd()}…`;
}
