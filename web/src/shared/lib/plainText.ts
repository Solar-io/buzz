/**
 * Markdown → one line of plain text, for the places a message is quoted
 * rather than rendered: toast bodies, sidebar and inline-thread previews,
 * Work rows.
 *
 * The older strippers (`plainPreview` in channelActivity, `plainExcerpt` in
 * dmActivity) removed marker CHARACTERS, which leaves a markdown table as
 * "Game Model ------ ------ C Sol max" — the separator row survives as a run
 * of dashes (Phase 1 QA, 2026-09-30). This one works line by line, so a
 * structural line can be dropped whole.
 *
 * Pure and import-free so `node --test` loads it directly.
 */

/** `|---|:--:|` — a table's header separator, with or without edge pipes. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** A fence line, with or without an info string. */
const FENCE = /^\s*(```|~~~)/;
/** `[!NOTE]` and friends, with an optional title after them. */
const CALLOUT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

function plainLine(raw: string): string {
  let line = raw;
  // Block quotes (possibly nested), then a callout marker inside them.
  line = line.replace(/^\s*(>\s?)+/, "");
  line = line.replace(CALLOUT_MARKER, "");
  // Headings, list bullets and ordered-list numbers.
  line = line.replace(/^\s*#{1,6}\s+/, "");
  line = line.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
  // A table row: cells joined with a middle dot, edge pipes dropped.
  if (/^\s*\|.*\|\s*$/.test(line)) {
    line = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "")
      .join(" · ");
  }
  return line;
}

/**
 * Flatten `content` to plain text. Embeds become a short placeholder
 * (`options.embed`, for the feeds that already say "📷 image"), links keep
 * their label, emphasis / code / spoiler markers are dropped, and table
 * separators, fences and horizontal rules disappear.
 */
export function plainText(
  content: string,
  options: { embed?: string } = {},
): string {
  const embed = options.embed ?? "📎 attachment";
  const lines: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (TABLE_SEPARATOR.test(raw) || FENCE.test(raw)) {
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      continue; // a horizontal rule
    }
    const line = plainLine(raw);
    if (line.trim() !== "") {
      lines.push(line);
    }
  }
  return lines
    .join(" ")
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, embed)
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/(\*\*|__|~~|\|\||[*_`])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** {@link plainText}, cut to `max` characters with an ellipsis. */
export function plainExcerpt(
  content: string,
  max: number,
  options: { embed?: string } = {},
): string {
  const flat = plainText(content, options);
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}
