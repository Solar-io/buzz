import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki";

import { highlight } from "@/features/channels/ui/CodeBlock";
import { cn } from "@/shared/lib/cn";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { resolveShikiThemeName } from "@/shared/theme/theme-loader";

/**
 * A whole file's source with line numbers, highlighted by the same Shiki
 * engine (and theme) as a message's code block. Tokens render as elements,
 * never an HTML sink — this is untrusted content.
 *
 * A file past {@link MAX_HIGHLIGHT_LINES} renders plain: nobody needs line
 * 9,000 of a log coloured, and tokenising it would stall the pane.
 */
export const MAX_HIGHLIGHT_LINES = 4000;

export function CodeView({
  text,
  language,
  className,
}: {
  text: string;
  /** Shiki id, or "" for plain text. */
  language: string;
  className?: string;
}) {
  const { appliedThemeName } = useTheme();
  const themeName = resolveShikiThemeName(appliedThemeName);
  const source = text.replace(/\n$/, "");
  const lines = source.split("\n");
  const tooLong = lines.length > MAX_HIGHLIGHT_LINES;
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    setTokens(null);
    if (language === "" || tooLong) {
      return;
    }
    let cancelled = false;
    highlight(source, language, themeName)
      .then((result) => {
        if (!cancelled) {
          setTokens(result);
        }
      })
      .catch(() => {
        // Unknown language: plain text is a perfectly readable result.
      });
    return () => {
      cancelled = true;
    };
  }, [source, language, themeName, tooLong]);

  const gutter = String(lines.length).length;
  return (
    <div
      data-testid="file-code-view"
      className={cn(
        "overflow-auto rounded-lg border border-border bg-card font-mono text-xs leading-5",
        className,
      )}
    >
      <pre className="min-w-max py-2">
        <code>
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: source lines have no identity and never reorder
            <span key={index} className="flex">
              <span
                aria-hidden
                className="sticky left-0 shrink-0 bg-card pr-3 pl-3 text-right text-muted-foreground select-none"
                style={{ width: `${gutter + 3}ch` }}
              >
                {index + 1}
              </span>
              <span className="pr-4 whitespace-pre text-foreground">
                {tokens?.[index]
                  ? tokens[index].map((token, tokenIndex) => (
                      <span
                        // biome-ignore lint/suspicious/noArrayIndexKey: tokens within a line never reorder
                        key={tokenIndex}
                        style={token.color ? { color: token.color } : undefined}
                      >
                        {token.content}
                      </span>
                    ))
                  : line || " "}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
