/**
 * Which formatting marks are active at the composer's current selection.
 *
 * The desktop toolbar asks TipTap (`editor.isActive("bold")`). The web
 * composer is a plain `<textarea>` by an explicit decision, so there is no
 * document model to ask — the answer has to be read back out of the markdown
 * text around the selection.
 *
 * The definition used throughout this module is deliberately narrow and
 * checkable: **a mark is active exactly when pressing its button would REMOVE
 * it.** That makes `aria-pressed` a truthful description of what the control
 * will do, and it means every predicate here mirrors the corresponding
 * toggle-off branch in `composerFormat.ts` rather than re-implementing a
 * markdown parser.
 *
 * Where that question is genuinely ambiguous the answer is `false`, never a
 * guess:
 *
 * - A selection that straddles a code-fence boundary belongs to no single
 *   block, so `codeBlock` is false (see `fencedBlockAt`).
 * - Inline `code` is forced false inside a fenced block. A three-backtick
 *   fence is made of the same character as an inline span, so `` ` `` markers
 *   adjacent to a selection inside ```` ```x``` ```` would otherwise read as an
 *   inline span that is not there.
 * - Nested or overlapping wraps (`**_both_**`) report only the mark whose
 *   markers are immediately adjacent to the selection — the one a click would
 *   actually strip. The outer mark reads as inactive. That is a real
 *   limitation of reading marks off text rather than a document tree; it is
 *   under-reporting, which is the safe direction.
 * - A partially-marked selection ("half of this is bold") reads as inactive,
 *   because pressing the button would ADD a wrap rather than remove one.
 */

import {
  fencedBlockAt,
  lineRangeFor,
  ORDERED_ITEM_RE,
  wrapRange,
} from "./composerFormat.ts";

export interface ActiveMarks {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  codeBlock: boolean;
  link: boolean;
  bulletList: boolean;
  orderedList: boolean;
  quote: boolean;
  spoiler: boolean;
}

/**
 * True when `applyWrap(text, start, end, marker)` would UNWRAP rather than
 * wrap. Mirrors both of that function's toggle-off branches: the markers
 * inside the selection, and the markers immediately outside it.
 */
export function isWrapActive(
  text: string,
  start: number,
  end: number,
  marker: string,
): boolean {
  const range = wrapRange(text, start, end);
  const selected = text.slice(range.start, range.end);
  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= marker.length * 2
  ) {
    return true;
  }
  const before = text.slice(
    Math.max(0, range.start - marker.length),
    range.start,
  );
  const after = text.slice(range.end, range.end + marker.length);
  return (
    range.start > 0 &&
    before === marker &&
    after === marker &&
    range.end < text.length
  );
}

/**
 * True when every line the selection touches already starts with `marker` —
 * the condition `applyLinePrefix` uses to strip it instead of adding it.
 */
export function isLinePrefixActive(
  text: string,
  start: number,
  end: number,
  marker: string,
): boolean {
  const { lineStart, lineEnd } = lineRangeFor(text, start, end);
  return text
    .slice(lineStart, lineEnd)
    .split("\n")
    .every((line) => line.startsWith(marker));
}

/** True when every line the selection touches carries an "N. " marker. */
export function isOrderedListActive(
  text: string,
  start: number,
  end: number,
): boolean {
  const { lineStart, lineEnd } = lineRangeFor(text, start, end);
  return text
    .slice(lineStart, lineEnd)
    .split("\n")
    .every((line) => ORDERED_ITEM_RE.test(line));
}

/**
 * Markdown inline link spans on a line, as `[label](target)` ranges. Built per
 * call rather than shared: a `/g` regex carries `lastIndex` between uses, and a
 * predicate that returns early would leave the next caller mid-scan.
 */
const linkPattern = () => /\[[^\]\n]*\]\([^)\n]*\)/g;

/**
 * True when the selection lies entirely inside one `[label](target)` span.
 *
 * The link button does not toggle (it always inserts a fresh link template),
 * so this reports containment rather than "a click would remove it". It is
 * still the honest reading of "the caret is in a link", which is what the
 * desktop's `editor.isActive("link")` reports.
 */
export function isLinkActive(
  text: string,
  start: number,
  end: number,
): boolean {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const { lineStart, lineEnd } = lineRangeFor(text, lo, hi);
  const line = text.slice(lineStart, lineEnd);
  const pattern = linkPattern();
  for (
    let match = pattern.exec(line);
    match !== null;
    match = pattern.exec(line)
  ) {
    const spanStart = lineStart + match.index;
    const spanEnd = spanStart + match[0].length;
    if (lo >= spanStart && hi <= spanEnd) {
      return true;
    }
  }
  return false;
}

/** Read every toolbar mark at once for one selection. */
export function activeMarks(
  text: string,
  start: number,
  end: number,
): ActiveMarks {
  const insideFence = fencedBlockAt(text, start, end) !== null;
  return {
    bold: isWrapActive(text, start, end, "**"),
    italic: isWrapActive(text, start, end, "_"),
    strike: isWrapActive(text, start, end, "~~"),
    // Inside a fence the surrounding backticks belong to the fence, not to an
    // inline span — see the module comment.
    code: !insideFence && isWrapActive(text, start, end, "`"),
    codeBlock: insideFence,
    link: isLinkActive(text, start, end),
    bulletList: isLinePrefixActive(text, start, end, "- "),
    orderedList: isOrderedListActive(text, start, end),
    quote: isLinePrefixActive(text, start, end, "> "),
    spoiler: isWrapActive(text, start, end, "||"),
  };
}

/** No mark active — the state to render before a textarea exists. */
export const NO_ACTIVE_MARKS: ActiveMarks = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  codeBlock: false,
  link: false,
  bulletList: false,
  orderedList: false,
  quote: false,
  spoiler: false,
};
