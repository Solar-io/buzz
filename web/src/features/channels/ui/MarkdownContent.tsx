import {
  isValidElement,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { openLink } from "@/shared/lib/linkOpen";
import { Lightbox, type LightboxItem } from "@/shared/ui/Lightbox";
import { useSnapshotPreview } from "@/features/agents/ui/SnapshotPreviewProvider";
import type { ImetaEntry } from "../lib/imetaEntries.ts";
import { mentionSetsEqual } from "../lib/mentionSets.ts";
import { mentionParts } from "../lib/mentionParts.ts";
import { CodeBlock, extractLanguage } from "./CodeBlock";
import { resolveSnapshotCard } from "../lib/snapshotCard.ts";
import { SnapshotCard } from "./SnapshotCard.tsx";
import { galleryFromTriggers, resolveFileCard } from "../lib/messageMedia.ts";
import { FileCard } from "./FileCard.tsx";
import { ImageMosaic } from "./ImageMosaic.tsx";
import {
  MessageMedia,
  MessageMediaProvider,
  type MessageMediaProps,
} from "./MessageMedia.tsx";

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
 * Split a paragraph's children into media and everything else.
 *
 * Media children are recognised by component identity — `MessageMedia` is
 * registered as react-markdown's `img` renderer, so every image node in the
 * tree is literally an element of that type. That is exact, unlike the
 * desktop's `data-block-media` prop sniffing, which has to cope with a deeper
 * component tree.
 *
 * Whitespace-only strings are not "other content": consecutive `![…](…)`
 * lines land in ONE paragraph separated by a soft-break "\n" text node, and
 * treating that newline as content would defeat every mosaic.
 */
function splitMediaChildren(children: ReactNode[]): {
  media: ReactElement<MessageMediaProps>[];
  other: ReactNode[];
} {
  const media: ReactElement<MessageMediaProps>[] = [];
  const other: ReactNode[] = [];
  for (const child of children) {
    if (isValidElement(child) && child.type === MessageMedia) {
      media.push(child as ReactElement<MessageMediaProps>);
    } else if (!(typeof child === "string" && child.trim() === "")) {
      other.push(child);
    }
  }
  return { media, other };
}

/**
 * Render message markdown. react-markdown does not render raw HTML by
 * default, so content is structurally sanitized. @mention tokens get a
 * distinct style so addressed readers scan faster.
 *
 * Attachments (desktop `markdown.tsx` parity):
 * - Several standalone images in one paragraph render as a count-aware
 *   mosaic; a single image keeps its own aspect-ratio frame.
 * - Every image is a lightbox trigger, and the lightbox opens as a gallery
 *   over the images of THIS message — the root div below is the scope.
 * - A link (or, from the CLI, an `![image](…)` node) whose imeta MIME is
 *   neither image nor video renders as a download card.
 *
 * Snapshot links: when an imeta map is supplied (ChannelTimeline/ThreadPanel)
 * and a link classifies as a snapshot candidate, it renders as a SnapshotCard
 * instead of a plain link. Without imeta the same link degrades to a plain
 * link — same as the desktop.
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
    const rootRef = useRef<HTMLDivElement>(null);
    const [gallery, setGallery] = useState<{
      items: LightboxItem[];
      index: number;
      /** The clicked tile — focus returns here when the lightbox closes. */
      trigger: HTMLElement;
    } | null>(null);

    /**
     * Build the gallery from the DOM at click time, scoped to this message.
     * DOM order is the only ordering that is guaranteed to match what the
     * reader sees — it survives mosaics, mixed paragraphs and images that
     * resolve out of order.
     */
    const openGallery = useCallback((trigger: HTMLElement) => {
      const root = rootRef.current;
      const triggers = root
        ? Array.from(
            root.querySelectorAll<HTMLElement>("[data-lightbox-trigger]"),
          )
        : [trigger];
      const next = galleryFromTriggers(triggers, trigger);
      if (next.items.length > 0) {
        setGallery({ ...next, trigger });
      }
    }, []);

    const mediaContext = useMemo(
      () => ({ imetaByUrl, openGallery }),
      [imetaByUrl, openGallery],
    );

    /**
     * The renderer map MUST be memoized on the message's own inputs.
     *
     * react-markdown uses these functions as React component types, so a
     * fresh object literal per render gives every node a new type and React
     * unmounts and remounts the ENTIRE markdown subtree. With gallery state
     * living in this component, an inline map meant that opening the lightbox
     * tore down and rebuilt every image — detaching the very button the
     * lightbox has to return focus to, and re-running each attachment's load
     * effect. Caught in a live browser, 2026-09-03; unit tests cannot see it.
     */
    const components = useMemo<Components>(
      () => ({
        p: ({ children }) => {
          const childArray = Array.isArray(children) ? children : [children];
          const { media, other } = splitMediaChildren(childArray);
          if (media.length >= 2 && other.length === 0) {
            return <ImageMosaic>{media}</ImageMosaic>;
          }
          return <p>{withMentions(children, mentionNames)}</p>;
        },
        li: ({ children }) => <li>{withMentions(children, mentionNames)}</li>,
        a: ({ href, children }) => {
          // Exact-match lookup, mirroring the desktop markdown.tsx
          // (`imetaByUrl?.get(href)`).
          const entry = imetaByUrl?.get(String(href ?? ""));
          const label = nodeText(children);
          const card = imetaByUrl
            ? resolveSnapshotCard(entry, href, label)
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
          // A generic file attachment: the desktop writes these as a
          // plain `[filename](url)` link, and only the imeta MIME can
          // tell them from an ordinary link.
          const file = resolveFileCard(entry, href, label);
          if (file) {
            return <FileCard {...file} />;
          }
          return <MessageLink href={href}>{children}</MessageLink>;
        },
        img: MessageMedia,
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
      }),
      [imetaByUrl, mentionNames, openSnapshotPreview, snapshotSharedBy],
    );

    return (
      <MessageMediaProvider value={mediaContext}>
        <div
          ref={rootRef}
          className="message-prose prose dark:prose-invert max-w-none break-words prose-p:my-1 prose-pre:my-2 prose-pre:font-mono prose-code:before:content-none prose-code:after:content-none"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </ReactMarkdown>
        </div>
        {gallery ? (
          <Lightbox
            items={gallery.items}
            index={gallery.index}
            returnFocusTo={gallery.trigger}
            onIndexChange={(index) =>
              setGallery((current) =>
                current === null ? current : { ...current, index },
              )
            }
            onClose={() => setGallery(null)}
          />
        ) : null}
      </MessageMediaProvider>
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
