/**
 * Split text into plain runs and resolved custom-emoji runs.
 *
 * The one shared primitive behind every custom-emoji render site: the message
 * body (through the remark plugin), reaction chips, and anything else that
 * shows user text. Keeping the matching rules here means a `:shortcode:` can
 * never resolve in one place and stay literal in another.
 *
 * Only KNOWN shortcodes match. An unknown `:foo:` stays literal text, which is
 * the NIP-30 fallback: a client that cannot resolve an emoji shows its name.
 */

export type ShortcodePart =
  | { kind: "text"; value: string }
  | { kind: "emoji"; shortcode: string; url: string; raw: string };

/**
 * Build the matcher for a palette. Returns null when the palette is empty —
 * there is nothing to match and callers should skip the walk entirely.
 *
 * Alternatives are ordered longest-first, matching the desktop plugin. Under
 * the current pattern that is belt-and-braces rather than load-bearing: the
 * trailing `:` forces the engine to backtrack out of `:party` and retry
 * `:party_parrot:` anyway, and a mutation reversing the sort leaves every test
 * green. It is kept because it stops depending on that backtracking, and the
 * cost is one comparison per build.
 */
export function buildShortcodePattern(
  shortcodes: ReadonlyArray<string>,
): RegExp | null {
  const sorted = [...new Set(shortcodes)]
    .filter((code) => code.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  if (sorted.length === 0) {
    return null;
  }
  const alternatives = sorted.map(escapeRegExp).join("|");
  // Case-insensitive: palette keys are lowercase, but content may be typed in
  // any case or arrive from another client that did not normalize.
  return new RegExp(`:(?:${alternatives}):`, "gi");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `text` against a palette. Returns a single text part when nothing
 * matched, so a caller can cheaply detect "no change" with `parts.length === 1
 * && parts[0].kind === "text"`.
 */
export function splitShortcodes(
  text: string,
  urlByShortcode: ReadonlyMap<string, string>,
  pattern?: RegExp | null,
): ShortcodePart[] {
  const matcher =
    pattern === undefined
      ? buildShortcodePattern([...urlByShortcode.keys()])
      : pattern;
  if (!matcher || text === "") {
    return [{ kind: "text", value: text }];
  }

  const parts: ShortcodePart[] = [];
  matcher.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while (true) {
    match = matcher.exec(text);
    if (!match) {
      break;
    }
    if (match.index > lastIndex) {
      parts.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    const shortcode = raw.slice(1, -1).toLowerCase();
    const url = urlByShortcode.get(shortcode);
    if (url) {
      parts.push({ kind: "emoji", shortcode, url, raw });
    } else {
      // The pattern is built from the palette's own keys, so this is
      // defensive; keep the raw text rather than dropping it.
      parts.push({ kind: "text", value: raw });
    }
    lastIndex = match.index + raw.length;
  }

  if (parts.length === 0) {
    return [{ kind: "text", value: text }];
  }
  if (lastIndex < text.length) {
    parts.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return parts;
}
