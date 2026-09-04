import { splitSearchMatches } from "../lib/searchMatch.ts";

/**
 * Text with the query's lexemes marked.
 *
 * `<mark>` rather than a styled `<span>`: the element carries the meaning
 * "relevant to a search" to assistive technology, which a background colour
 * does not. The colour is toned down from the browser default so a result row
 * does not read as a highlighter accident.
 */
export function HighlightedText({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}) {
  const parts = splitSearchMatches(text, query);
  return (
    <span className={className}>
      {parts.map((part) =>
        part.isMatch ? (
          <mark
            className="rounded-xs bg-primary/20 text-inherit"
            key={part.key}
          >
            {part.text}
          </mark>
        ) : (
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </span>
  );
}
