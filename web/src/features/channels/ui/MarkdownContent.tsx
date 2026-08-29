import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Render message markdown. react-markdown does not render raw HTML by
 * default, so content is structurally sanitized. @mention tokens get a
 * distinct style so addressed readers scan faster.
 */
export const MarkdownContent = memo(function MarkdownContent({
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
          li: ({ children }) => <li>{withMentions(children, mentionNames)}</li>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** Wrap @Name text nodes in a styled span (names matched case-insensitively). */
function withMentions(
  node: ReactNode,
  mentionNames: ReadonlySet<string>,
): ReactNode {
  if (typeof node === "string" && mentionNames.size > 0) {
    const parts: ReactNode[] = [];
    const rest = node;
    let key = 0;
    const pattern = /@([A-Za-z0-9_.-]+)/g;
    let match: RegExpExecArray | null;
    let last = 0;
    while ((match = pattern.exec(rest.slice(last))) !== null) {
      const name = match[1];
      if (!mentionNames.has(name.toLowerCase())) {
        continue;
      }
      const start = last + match.index;
      if (start > last) {
        parts.push(node.slice(last, start));
      }
      parts.push(
        <span
          key={`m${key++}`}
          className="rounded bg-accent px-0.5 font-medium text-accent-foreground"
        >
          @{name}
        </span>,
      );
      last = start + match[0].length;
    }
    if (parts.length === 0) {
      return node;
    }
    if (last < node.length) {
      parts.push(node.slice(last));
    }
    return parts;
  }
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      // Array children keep their original keys where present.
      <Fragmentish key={index}>{withMentions(child, mentionNames)}</Fragmentish>
    ));
  }
  return node;
}

function Fragmentish({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
