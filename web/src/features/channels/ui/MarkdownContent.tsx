import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { Lightbox } from "@/shared/ui/Lightbox";
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
      <div className="message-prose prose dark:prose-invert max-w-none break-words prose-p:my-1 prose-pre:my-2 prose-pre:font-mono prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p>{withMentions(children, mentionNames)}</p>,
            li: ({ children }) => (
              <li>{withMentions(children, mentionNames)}</li>
            ),
            img: ({ src, alt }) => (
              <SignedMedia src={String(src)} alt={alt ?? ""} />
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

/**
 * Relay media requires a signed GET — <img> cannot sign. Fetch as a blob and
 * render from the object URL (module-level cache dedupes across messages).
 */
function SignedMedia({ src, alt }: { src: string; alt: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchSignedMedia(src)
      .then((url) => {
        if (!cancelled) {
          setObjectUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (failed) {
    return (
      <a
        href={src}
        className="text-xs text-muted-foreground underline"
        onClick={(event) => event.preventDefault()}
      >
        [media unavailable — {alt}]
      </a>
    );
  }
  if (alt === "video") {
    return objectUrl ? (
      // Uploaded videos carry no caption tracks; aria-label is the best
      // available label. Suppression is deliberate, not an oversight.
      // biome-ignore lint/a11y/useMediaCaption: no caption track exists for user uploads
      <video
        src={objectUrl}
        controls
        playsInline
        aria-label={alt === "video" ? "Video attachment" : alt}
        className="max-h-96 rounded-lg"
      />
    ) : (
      <div className="h-24 w-48 animate-pulse rounded-lg bg-muted" />
    );
  }
  return objectUrl ? (
    <>
      <button
        type="button"
        aria-label={alt ? `Enlarge image: ${alt}` : "Enlarge image"}
        className="block cursor-zoom-in rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setEnlarged(true)}
      >
        <img
          src={objectUrl}
          alt={alt}
          className="max-h-96 max-w-full rounded-lg"
          loading="lazy"
        />
      </button>
      {enlarged && (
        <Lightbox
          src={objectUrl}
          alt={alt}
          onClose={() => setEnlarged(false)}
        />
      )}
    </>
  ) : (
    <div className="h-24 w-48 animate-pulse rounded-lg bg-muted" />
  );
}
