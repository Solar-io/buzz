/**
 * Composer rich-text helpers: markdown wrapping for the formatting toolbar
 * (bold/italic/strike/code/link) and line-prefix formats (list, quote).
 * All functions are pure — the composer applies the result and restores the
 * returned selection.
 */

export interface FormatResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/**
 * Wrap the selection with prefix/suffix. Toggles: an already-wrapped
 * selection unwraps. An empty selection inserts prefix+suffix with the caret
 * between them (word-wraps when the caret sits inside a word).
 */
export function applyWrap(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix = prefix,
): FormatResult {
  // Extend a collapsed caret to the surrounding word.
  if (start === end) {
    const wordStart = text.lastIndexOf(" ", start - 1) + 1;
    const nextSpace = text.indexOf(" ", start);
    const wordEnd = nextSpace === -1 ? text.length : nextSpace;
    if (wordEnd > wordStart) {
      start = wordStart;
      end = wordEnd;
    }
  }
  const selected = text.slice(start, end);
  // Toggle off when the selection is already wrapped.
  if (
    selected.startsWith(prefix) &&
    selected.endsWith(suffix) &&
    selected.length >= prefix.length + suffix.length
  ) {
    const inner = selected.slice(
      prefix.length,
      selected.length - suffix.length,
    );
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selStart: start,
      selEnd: start + inner.length,
    };
  }
  // Also toggle when the wrapping sits OUTSIDE the selection (cursor inside).
  const before = text.slice(Math.max(0, start - prefix.length), start);
  const after = text.slice(end, end + suffix.length);
  if (
    start > 0 &&
    before === prefix &&
    after === suffix &&
    start + (end - start) < text.length
  ) {
    return {
      text:
        text.slice(0, start - prefix.length) +
        selected +
        text.slice(end + suffix.length),
      selStart: start - prefix.length,
      selEnd: end - prefix.length,
    };
  }
  return {
    text: text.slice(0, start) + prefix + selected + suffix + text.slice(end),
    selStart: start + prefix.length,
    selEnd: start + prefix.length + selected.length,
  };
}

/** Link format: [selection](url) — empty selection becomes [](url-cursor). */
export function applyLink(
  text: string,
  start: number,
  end: number,
): FormatResult {
  const selected = text.slice(start, end);
  const insertion = `[${selected || "text"}](url)`;
  // Select the "url" placeholder for immediate overtyping.
  const urlAt = start + insertion.indexOf("url");
  return {
    text: text.slice(0, start) + insertion + text.slice(end),
    selStart: urlAt,
    selEnd: urlAt + 3,
  };
}

/** Prefix every line touched by the selection (list bullets, quotes). */
export function applyLinePrefix(
  text: string,
  start: number,
  end: number,
  marker: string,
): FormatResult {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lastNl = text.indexOf("\n", end);
  const lineEnd = lastNl === -1 ? text.length : lastNl;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  // Toggle: when every line already carries the marker, remove it instead.
  const allPrefixed = lines.every((line) => line.startsWith(marker));
  const next = lines
    .map((line) => (allPrefixed ? line.slice(marker.length) : marker + line))
    .join("\n");
  const lengthDelta = next.length - block.length;
  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selStart: start,
    selEnd: Math.max(start, end + lengthDelta),
  };
}

/** Inline-code variant of applyWrap for the toolbar's `code` button. */
export function applyCode(
  text: string,
  start: number,
  end: number,
): FormatResult {
  return applyWrap(text, start, end, "`");
}
