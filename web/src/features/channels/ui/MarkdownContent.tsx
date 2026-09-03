import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { openLink } from "@/shared/lib/linkOpen";
import { Lightbox } from "@/shared/ui/Lightbox";
import { useSnapshotPreview } from "@/features/agents/ui/SnapshotPreviewProvider";
import type { ImetaEntry } from "../lib/imetaEntries.ts";
import { mentionSetsEqual } from "../lib/mentionSets.ts";
import { mentionParts } from "../lib/mentionParts.ts";
import { CodeBlock, extractLanguage } from "./CodeBlock";
import { resolveSnapshotCard } from "../lib/snapshotCard.ts";
import { SnapshotCard } from "./SnapshotCard.tsx";

/**
 * Message links must never navigate the SPA tab away. Plain links open in a
 * new tab; file-typical links open in a popup viewer window (relay media is
 * signed-fetched first). Modifier-clicks keep native behavior.
 */
function MessageLink({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      title={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2"
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const target = String(href ?? "");
        if (target === "") {
          return;
        }
        event.preventDefault();
        void openLink(target, {
          relayBase: relayHttpBaseUrl(),
          fetchSigned: fetchSignedMedia,
          onError: (message) => toast.error(message),
        });
      }}
    >
      {children}
    </a>
  );
}

/** Flatten anchor children to their literal text (the card-classifier label). */
function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(nodeText).join("");
  }
  return "";
}

/**
 * Render message markdown. react-markdown does not render raw HTML by
 * default, so content is structurally sanitized. @mention tokens get a
 * distinct style so addressed readers scan faster.
 *
 * Snapshot links: when an imeta map is supplied (ChannelTimeline/ThreadPanel)
 * and a link classifies as a snapshot candidate, it renders as a SnapshotCard
 * instead of a plain link (desktop markdown.tsx parity). Without imeta the
 * same link degrades to a plain link — same as the desktop.
 *
 * memo uses a custom comparator: a fresh Set instance must NOT bust the
 * memo (see lib/mentionSets.ts). The imeta map compares BY REFERENCE — it is
 * a per-message construction-time constant (messageBuffer.ts), so reference
 * equality is the correct identity.
 */
export const MarkdownContent = memo(
  function MarkdownContent({
    content,
    mentionNames,
    imetaByUrl,
    snapshotSharedBy,
  }: {
    content: string;
    mentionNames: ReadonlySet<string>;
    /** NIP-92 attachment metadata for this message, from TimelineMessage. */
    imetaByUrl?: Map<string, ImetaEntry>;
    /** Author label for the "Shared by" line on snapshot cards. */
    snapshotSharedBy?: string;
  }) {
    const openSnapshotPreview = useSnapshotPreview();
    return (
      <div className="message-prose prose dark:prose-invert max-w-none break-words prose-p:my-1 prose-pre:my-2 prose-pre:font-mono prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p>{withMentions(children, mentionNames)}</p>,
            li: ({ children }) => (
              <li>{withMentions(children, mentionNames)}</li>
            ),
            a: ({ href, children }) => {
              // Exact-match lookup, mirroring the desktop markdown.tsx
              // (`imetaByUrl?.get(href)`).
              const card = imetaByUrl
                ? resolveSnapshotCard(
                    imetaByUrl.get(String(href ?? "")),
                    href,
                    nodeText(children),
                  )
                : null;
              if (card) {
                return (
                  <SnapshotCard
                    card={card}
                    sharedBy={snapshotSharedBy}
                    onPreview={
                      openSnapshotPreview
                        ? () => openSnapshotPreview(card, snapshotSharedBy)
                        : undefined
                    }
                  />
                );
              }
              return <MessageLink href={href}>{children}</MessageLink>;
            },
            img: ({ src, alt }) => (
              <SignedMedia src={String(src)} alt={alt ?? ""} />
            ),
            // react-markdown hands fenced blocks to `code` wrapped in a
            // `pre`; inline code arrives here too, distinguished only by the
            // absence of a language class and of a newline. Only fenced
            // blocks become CodeBlock — inline `code` must stay inline.
            code: ({ className, children, ...rest }) => {
              const language = extractLanguage(className);
              const text = nodeText(children);
              const fenced = language !== "" || text.includes("\n");
              if (!fenced) {
                return (
                  <code className={className} {...rest}>
                    {children}
                  </code>
                );
              }
              return (
                <CodeBlock code={text.replace(/\n$/, "")} language={language}>
                  {children}
                </CodeBlock>
              );
            },
            // CodeBlock renders its own <pre>; without this react-markdown
            // would nest one inside another and the layout would double up.
            pre: ({ children }) => <>{children}</>,
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  },
  (prev, next) =>
    prev.content === next.content &&
    mentionSetsEqual(prev.mentionNames, next.mentionNames) &&
    prev.imetaByUrl === next.imetaByUrl &&
    prev.snapshotSharedBy === next.snapshotSharedBy,
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
