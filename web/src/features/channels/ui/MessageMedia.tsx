import { useContext, useEffect, useState, type CSSProperties } from "react";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/shared/lib/cn";
import {
  type FileCardTarget,
  mediaFrame,
  resolveFileCard,
  resolveInlineAudio,
} from "../lib/messageMedia.ts";
import { FileCard } from "./FileCard.tsx";
import { MessageMediaContext } from "./messageMediaContext.ts";

export type { MessageMediaContextValue } from "./messageMediaContext.ts";

export const MessageMediaProvider = MessageMediaContext.Provider;

export interface MessageMediaProps {
  src?: string;
  alt?: string;
  /** Set by ImageMosaic: fill the grid tile instead of a self-sized frame. */
  mosaic?: boolean;
}

/**
 * Renderer for a markdown image node.
 *
 * Three outcomes, decided before any state is taken so the hook order stays
 * constant: a download card for a non-media attachment (the CLI writes
 * `![image](url)` for EVERY upload, PDFs included — see `messages.rs`), an
 * inline audio player (MP3), a video player, or an image.
 */
export function MessageMedia({ src, alt, mosaic = false }: MessageMediaProps) {
  const { imetaByUrl, openGallery } = useContext(MessageMediaContext);
  const url = String(src ?? "");
  const entry = imetaByUrl?.get(url);
  const label = alt ?? "";

  const fileCard = resolveFileCard(entry, url, label);
  if (fileCard) {
    return <FileCard {...fileCard} />;
  }

  const audio = resolveInlineAudio(entry, url, label);
  if (audio) {
    return <SignedAudio {...audio} />;
  }

  if (label === "video" || entry?.m?.startsWith("video/")) {
    return <SignedVideo src={url} alt={label} dim={entry?.dim} />;
  }

  return (
    <SignedImage
      src={url}
      alt={label}
      dim={entry?.dim}
      mosaic={mosaic}
      openGallery={openGallery}
    />
  );
}

/**
 * Reserve the layout box from the NIP-92 `dim` before the bytes arrive.
 *
 * This is what stops the timeline reflowing as images load: the frame is at
 * its final size on first paint, and the decoded image fills a box that was
 * already there. Inside a mosaic the grid owns the geometry instead, so the
 * frame simply fills its tile.
 */
function frameStyle(dim: string | undefined, mosaic: boolean): CSSProperties {
  if (mosaic) {
    return {};
  }
  const frame = mediaFrame(dim);
  return {
    aspectRatio: frame.aspectRatio,
    width: frame.width,
    maxWidth: "100%",
  };
}

/**
 * Relay media requires a signed GET — `<img>` cannot sign. Fetch as a blob and
 * render from the object URL (`fetchSignedMedia` caches per URL, so the same
 * attachment across messages costs one request).
 */
function useSignedMedia(src: string) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setObjectUrl(null);
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

  return { objectUrl, failed };
}

function MediaUnavailable({ src, alt }: { src: string; alt: string }) {
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

function SignedImage({
  src,
  alt,
  dim,
  mosaic,
  openGallery,
}: {
  src: string;
  alt: string;
  dim?: string;
  mosaic: boolean;
  openGallery: (trigger: HTMLElement) => void;
}) {
  const { objectUrl, failed } = useSignedMedia(src);

  if (failed) {
    return <MediaUnavailable src={src} alt={alt} />;
  }

  return (
    <span
      data-media-block=""
      className={cn("my-1 block min-w-0 max-w-full", mosaic && "h-full")}
    >
      <button
        type="button"
        data-lightbox-trigger=""
        data-lightbox-src={objectUrl ?? undefined}
        data-lightbox-alt={alt}
        aria-label={alt ? `Enlarge image: ${alt}` : "Enlarge image"}
        disabled={objectUrl === null}
        className={cn(
          "relative block overflow-hidden rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          objectUrl === null ? "cursor-default" : "cursor-zoom-in",
          mosaic && "h-full w-full rounded-none",
        )}
        style={frameStyle(dim, mosaic)}
        onClick={(event) => openGallery(event.currentTarget)}
      >
        {objectUrl === null ? (
          <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
        ) : (
          <img
            src={objectUrl}
            alt={alt}
            loading="lazy"
            decoding="async"
            className={cn(
              "absolute inset-0 h-full w-full",
              mosaic ? "object-cover" : "object-contain",
            )}
          />
        )}
      </button>
    </span>
  );
}

function SignedVideo({
  src,
  alt,
  dim,
}: {
  src: string;
  alt: string;
  dim?: string;
}) {
  const { objectUrl, failed } = useSignedMedia(src);

  if (failed) {
    return <MediaUnavailable src={src} alt={alt} />;
  }

  return (
    <span data-media-block="" className="my-1 block min-w-0 max-w-full">
      <span
        className="relative block overflow-hidden rounded-lg"
        style={frameStyle(dim, false)}
      >
        {objectUrl === null ? (
          <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
        ) : (
          // Uploaded videos carry no caption tracks; aria-label is the best
          // available label. Suppression is deliberate, not an oversight.
          // biome-ignore lint/a11y/useMediaCaption: no caption track exists for user uploads
          <video
            src={objectUrl}
            controls
            playsInline
            aria-label={alt === "video" ? "Video attachment" : alt}
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
      </span>
    </span>
  );
}

/**
 * Inline player for an MP3 attachment (`resolveInlineAudio`). Rendered for
 * both the `[song.mp3](url)` link the CLI and desktop write and an image node.
 * Like video, the bytes come through a signed GET as an object URL — an
 * `<audio src>` cannot sign the request.
 */
export function SignedAudio({ href, filename }: FileCardTarget) {
  const { objectUrl, failed } = useSignedMedia(href);

  if (failed) {
    return <MediaUnavailable src={href} alt={filename} />;
  }

  return (
    <span
      data-media-block=""
      data-testid="message-audio"
      className="my-1 flex w-full max-w-sm min-w-0 flex-col gap-1 rounded-lg border border-border/70 bg-muted/40 px-3 py-2"
    >
      <span className="truncate text-xs font-medium text-foreground">
        {filename}
      </span>
      {objectUrl === null ? (
        <Skeleton className="h-8 w-full" />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: no caption track exists for user uploads
        <audio
          src={objectUrl}
          controls
          preload="metadata"
          aria-label={`Audio attachment: ${filename}`}
          className="h-8 w-full"
        />
      )}
    </span>
  );
}
