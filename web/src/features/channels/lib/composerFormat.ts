/**
 * Composer rich-text helpers: markdown wrapping for the formatting toolbar
 * (bold/italic/strike/code/link/spoiler) and block formats (bullet list,
 * ordered list, quote, fenced code block). All functions are pure — the
 * composer applies the result and restores the returned selection.
 *
 * These mirror the ten buttons the desktop client's `FormattingToolbar` puts
 * on a TipTap editor. The web composer is a plain `<textarea>` by an explicit
 * decision, so every format here is expressed as a markdown text transform
 * rather than an editor command; the wire format is identical either way.
 */

export interface FormatResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/** The three-backtick fence a code block opens and closes with. */
export const CODE_FENCE = "```";

/** An ordered-list marker at the start of a line: "1. ", "12. ". */
export const ORDERED_ITEM_RE = /^\d+\.\s/;

/**
 * The range {@link applyWrap} will actually operate on: a collapsed caret
 * extends to the surrounding word, everything else is used as-is.
 *
 * Exported so the toolbar's active-mark detection can ask the question over
 * the same range the click would act on. Reading the mark state off the raw
 * caret instead would make a button report "not bold" for a caret sitting in
 * the middle of a bold word that clicking it would un-bold.
 */
export function wrapRange(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  if (start !== end) {
    return { start, end };
  }
  const wordStart = text.lastIndexOf(" ", start - 1) + 1;
  const nextSpace = text.indexOf(" ", start);
  const wordEnd = nextSpace === -1 ? text.length : nextSpace;
  return wordEnd > wordStart
    ? { start: wordStart, end: wordEnd }
    : { start, end };
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
  ({ start, end } = wrapRange(text, start, end));
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

/** The line range (start-of-first-line .. end-of-last-line) a selection spans. */
export function lineRangeFor(
  text: string,
  start: number,
  end: number,
): { lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextNewline = text.indexOf("\n", end);
  return {
    lineStart,
    lineEnd: nextNewline === -1 ? text.length : nextNewline,
  };
}

/** Prefix every line touched by the selection (list bullets, quotes). */
export function applyLinePrefix(
  text: string,
  start: number,
  end: number,
  marker: string,
): FormatResult {
  const { lineStart, lineEnd } = lineRangeFor(text, start, end);
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

/** One fenced code block found in the composer text, by character offset. */
export interface FencedBlock {
  /** First character of the opening fence line. */
  openStart: number;
  /** First character of the line after the opening fence. */
  contentStart: number;
  /** One past the last content character (excludes the newline before close). */
  contentEnd: number;
  /** One past the last character of the closing fence line. */
  closeEnd: number;
  /** True when no closing fence exists yet — the block runs to end of text. */
  unterminated: boolean;
}

/**
 * Every fenced code block in `text`, in order.
 *
 * A fence line is any line whose first non-space content is ```` ``` ````, so an
 * info string (```` ```ts ````) opens a block exactly as a bare fence does.
 * Fences alternate open/close; a trailing unclosed fence is reported as an
 * unterminated block running to the end of the text, which is what a
 * half-typed code block actually is.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const isFence = (line: string) => line.trimStart().startsWith(CODE_FENCE);

  const blocks: FencedBlock[] = [];
  let openLine: number | null = null;
  for (let index = 0; index < lines.length; index++) {
    if (!isFence(lines[index])) {
      continue;
    }
    if (openLine === null) {
      openLine = index;
      continue;
    }
    const contentStart = lineStarts[openLine + 1] ?? text.length;
    const closeLineStart = lineStarts[index];
    blocks.push({
      openStart: lineStarts[openLine],
      contentStart,
      contentEnd: Math.max(contentStart, closeLineStart - 1),
      closeEnd: closeLineStart + lines[index].length,
      unterminated: false,
    });
    openLine = null;
  }
  if (openLine !== null) {
    const contentStart = lineStarts[openLine + 1] ?? text.length;
    blocks.push({
      openStart: lineStarts[openLine],
      contentStart,
      contentEnd: text.length,
      closeEnd: text.length,
      unterminated: true,
    });
  }
  return blocks;
}

/**
 * The fenced block that fully contains `[start, end]`, or null.
 *
 * A selection straddling a fence boundary belongs to no single block and
 * returns null: the honest answer for the toolbar is "not inside a code
 * block", because there is no one block a toggle could remove.
 */
export function fencedBlockAt(
  text: string,
  start: number,
  end: number,
): FencedBlock | null {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return (
    fencedBlocks(text).find(
      (block) => lo >= block.openStart && hi <= block.closeEnd,
    ) ?? null
  );
}

/**
 * Fenced code block, the desktop toolbar's `Code block` button.
 *
 * Block-level like the list and quote formats: it operates on whole lines, not
 * on the character selection, because a fence that starts mid-line is not a
 * fence. When the selection already sits inside a fenced block, the fences are
 * removed — including from the middle of a long block, so the button toggles
 * wherever the caret is rather than only on the block's edges.
 */
export function applyCodeBlock(
  text: string,
  start: number,
  end: number,
): FormatResult {
  const enclosing = fencedBlockAt(text, start, end);
  if (enclosing) {
    const inner = text.slice(enclosing.contentStart, enclosing.contentEnd);
    return {
      text:
        text.slice(0, enclosing.openStart) +
        inner +
        text.slice(enclosing.closeEnd),
      selStart: enclosing.openStart,
      selEnd: enclosing.openStart + inner.length,
    };
  }

  const { lineStart, lineEnd } = lineRangeFor(text, start, end);
  const block = text.slice(lineStart, lineEnd);
  const opening = `${CODE_FENCE}\n`;
  const fenced = `${opening}${block}\n${CODE_FENCE}`;
  const innerStart = lineStart + opening.length;
  return {
    text: text.slice(0, lineStart) + fenced + text.slice(lineEnd),
    selStart: innerStart,
    selEnd: innerStart + block.length,
  };
}

/**
 * Ordered list. Numbers every line the selection touches from 1, and toggles
 * the whole block off when every line already carries a numeric marker.
 *
 * Renumbering rather than prefixing a fixed string is what separates this from
 * {@link applyLinePrefix}: the marker differs per line, so sharing that
 * implementation would either emit "1. " on every line or fail to toggle off.
 */
export function applyOrderedList(
  text: string,
  start: number,
  end: number,
): FormatResult {
  const { lineStart, lineEnd } = lineRangeFor(text, start, end);
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const allNumbered = lines.every((line) => ORDERED_ITEM_RE.test(line));
  const next = lines
    .map((line, index) =>
      allNumbered ? line.replace(ORDERED_ITEM_RE, "") : `${index + 1}. ${line}`,
    )
    .join("\n");
  const lengthDelta = next.length - block.length;
  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selStart: start,
    selEnd: Math.max(start, end + lengthDelta),
  };
}

/**
 * Spoiler: Discord-style `||hidden||`, the same wire syntax the desktop
 * composer's spoiler mark serializes to (see
 * `desktop/src/features/messages/lib/spoilerMark.ts`, which parses `||…||`
 * with the first inner `||` closing the span).
 */
export function applySpoiler(
  text: string,
  start: number,
  end: number,
): FormatResult {
  return applyWrap(text, start, end, "||");
}
