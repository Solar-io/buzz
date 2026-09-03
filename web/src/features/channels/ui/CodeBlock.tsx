import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ThemedToken } from "shiki";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { resolveShikiThemeName } from "@/shared/theme/theme-loader";
import { cn } from "@/shared/lib/cn";

/**
 * Syntax-highlighted fenced code block with a copy button.
 *
 * Highlighting is the same Shiki engine that backs the theme system, so a
 * code block is always tokenised against the theme the rest of the interface
 * was derived from — pick Catppuccin Mocha and the code matches it.
 *
 * Three deliberate limits, all borrowed from the desktop's CodeBlock:
 *
 * - The highlighter, languages and themes load lazily and are cached across
 *   every block on the page. Shiki's engine is large; loading it eagerly for
 *   a conversation that may contain no code at all is not worth it.
 * - Highlighting is capped at {@link MAX_HIGHLIGHT_LINES}. A pasted 10k-line
 *   file should not lock the render thread, and nobody reads line 4000 of a
 *   chat message.
 * - Tokens are rendered as React elements, never `dangerouslySetInnerHTML`.
 *   This renders untrusted message content; Shiki escapes its output, but
 *   not introducing an HTML sink at all is the stronger position.
 *
 * Until tokens resolve — and if the language is unknown or highlighting
 * throws — the block renders as plain monospace text. That is a legible
 * fallback, not an error state.
 */

const MAX_HIGHLIGHT_LINES = 150;
const MAX_CACHE_ENTRIES = 100;

type Highlighter = Awaited<
  ReturnType<typeof import("shiki").getSingletonHighlighter>
>;

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>();
const loadedThemes = new Set<string>();
const tokenCache = new Map<string, ThemedToken[][]>();

function ensureHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.getSingletonHighlighter({ themes: [], langs: [] }),
    );
  }
  return highlighterPromise;
}

/** Extract the language from react-markdown's `language-xxx` class. */
export function extractLanguage(className?: string): string {
  if (typeof className !== "string") return "";
  const match = className.match(/language-(\S+)/);
  return match ? match[1] : "";
}

function cacheTokens(key: string, tokens: ThemedToken[][]): void {
  if (tokenCache.size >= MAX_CACHE_ENTRIES) {
    // Cheap FIFO eviction — the first inserted key is the oldest.
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(key, tokens);
}

async function highlight(
  code: string,
  language: string,
  themeName: string,
): Promise<ThemedToken[][] | null> {
  const highlighter = await ensureHighlighter();

  if (!loadedThemes.has(themeName)) {
    await highlighter.loadTheme(
      themeName as Parameters<typeof highlighter.loadTheme>[0],
    );
    loadedThemes.add(themeName);
  }

  if (!loadedLanguages.has(language)) {
    // An unknown language is the common case (```text, ```sh typos, a bare
    // fence); treat it as "no highlighting" rather than an error.
    await highlighter.loadLanguage(
      language as Parameters<typeof highlighter.loadLanguage>[0],
    );
    loadedLanguages.add(language);
  }

  const { tokens } = highlighter.codeToTokens(code, {
    lang: language as never,
    theme: themeName as never,
  });
  return tokens;
}

export function CodeBlock({
  code,
  language,
  children,
}: {
  /** Raw source, already stripped of the trailing newline. */
  code: string;
  /** Language id from the fence, or "" when the fence carried none. */
  language: string;
  /** Plain-text fallback, rendered until (or unless) tokens resolve. */
  children?: ReactNode;
}) {
  const { appliedThemeName } = useTheme();
  const themeName = resolveShikiThemeName(appliedThemeName);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lineCount = code.split("\n").length;
  const tooLong = lineCount > MAX_HIGHLIGHT_LINES;

  useEffect(() => {
    if (!language || tooLong) {
      setTokens(null);
      return;
    }
    const key = `${themeName}:${language}:${code}`;
    const cached = tokenCache.get(key);
    if (cached) {
      setTokens(cached);
      return;
    }
    let cancelled = false;
    void highlight(code, language, themeName)
      .then((result) => {
        if (cancelled || !result) return;
        cacheTokens(key, result);
        setTokens(result);
      })
      .catch(() => {
        // Unknown language or a theme that failed to load — plain text is a
        // perfectly readable result, so there is nothing to report.
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language, themeName, tooLong]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const onCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="group/code relative my-2">
      {language && (
        <span className="pointer-events-none absolute top-1.5 left-3 font-mono text-[0.6875rem] text-muted-foreground/70 select-none">
          {language}
        </span>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        className={cn(
          "absolute top-1.5 right-1.5 rounded-md border border-border/60 bg-background/90 p-1.5",
          "text-muted-foreground opacity-0 transition-opacity",
          "group-hover/code:opacity-100 focus-visible:opacity-100",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>

      <pre
        className={cn(
          "overflow-x-auto rounded-md border border-border/60 bg-muted/40 font-mono text-sm",
          language ? "px-3 pt-6 pb-3" : "p-3",
        )}
      >
        <code>
          {tokens
            ? tokens.map((line, lineIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: token lines have no id and never reorder
                <span className="block" key={lineIndex}>
                  {line.length === 0 ? (
                    "\n"
                  ) : (
                    <>
                      {line.map((token, tokenIndex) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: tokens within a line never reorder
                          key={tokenIndex}
                          style={
                            token.color ? { color: token.color } : undefined
                          }
                        >
                          {token.content}
                        </span>
                      ))}
                      {"\n"}
                    </>
                  )}
                </span>
              ))
            : (children ?? code)}
        </code>
      </pre>
    </div>
  );
}
