import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mentionSetsEqual } from "../lib/mentionSets.ts";
import { mentionParts } from "../lib/mentionParts.ts";

/**
 * Render message markdown. react-markdown does not render raw HTML by
 * default, so content is structurally sanitized. @mention tokens get a
 * distinct style so addressed readers scan faster.
 *
 * memo uses a custom comparator: a fresh Set instance must NOT bust the
 * memo (see lib/mentionSets.ts).
 */
export const MarkdownContent = memo(
  function MarkdownContent({
    content,
    mentionNames,
  }: {
    content: string;
    mentionNames: ReadonlySet<string>;
  }) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none break-words prose-p:my-1 prose-pre:my-2 prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p>{withMentions(children, mentionNames)}</p>,
            li: ({ children }) => (
              <li>{withMentions(children, mentionNames)}</li>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  },
  (prev, next) =>
    prev.content === next.content &&
    mentionSetsEqual(prev.mentionNames, next.mentionNames),
);

/** Wrap @Name text nodes in a styled span (names matched case-insensitively). */
function withMentions(
  node: ReactNode,
  mentionNames: ReadonlySet<string>,
): ReactNode {
  if (typeof node === "string") {
    const split = mentionParts(node, mentionNames);
    if (!split) {
      return node;
    }
    return split.map((part) =>
      part.kind === "mention" ? (
        <span
          key={part.key}
          className="rounded bg-accent px-0.5 font-medium text-accent-foreground"
        >
          {part.text}
        </span>
      ) : (
        part.text
      ),
    );
  }
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      // react-markdown children carry no stable ids; index keys are safe
      // because the array is static per render.
      // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
      <Fragmentish key={index}>{withMentions(child, mentionNames)}</Fragmentish>
    ));
  }
  return node;
}

function Fragmentish({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
