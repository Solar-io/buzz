import { useEffect, useState } from "react";

import { fetchSignedMedia } from "@/shared/api/blossom";
import { isRelayMediaHref } from "@/shared/lib/linkOpen";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { useLinkPreviewStyle } from "@/features/settings/lib/appearanceStore.ts";
import type { LinkPreview } from "../lib/linkPreview.ts";

/**
 * A preview asset, fetched with a signed GET when it lives on this relay.
 *
 * Every snapshot asset does: the relay refuses a snapshot whose image or
 * favicon is not one of its own blobs. And `GET /media/{sha256}` runs
 * `authenticate_media_read` (crates/buzz-relay/src/api/media.rs), which an
 * `<img>` element cannot satisfy — it has no way to sign a NIP-98 header. A
 * plain `src` therefore renders every relay-hosted preview image broken, the
 * same defect custom emoji had. `fetchSignedMedia` caches one object URL per
 * source URL app-wide, so the same card scrolled past twice costs one request.
 *
 * A failed fetch renders nothing rather than a broken-image glyph: a preview
 * is decoration, and it must never take a message row down with it.
 */
function PreviewImage({
  alt,
  className,
  url,
}: {
  alt: string;
  className: string;
  url: string;
}) {
  const needsSignedGet = isRelayMediaHref(url, relayHttpBaseUrl());
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!needsSignedGet) {
      setSignedUrl(null);
      return;
    }
    let cancelled = false;
    fetchSignedMedia(url)
      .then((objectUrl) => {
        if (!cancelled) setSignedUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsSignedGet, url]);

  const src = needsSignedGet ? signedUrl : url;
  if (failed || !src) {
    return null;
  }
  return (
    <img
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}

/**
 * Sender-authored link preview cards.
 *
 * Every asset here is already hosted on this relay — the relay refuses a
 * snapshot whose image or favicon is not a local blob — so rendering a card
 * makes no request to the linked site. That is the privacy property the
 * feature exists for: reading a channel must not tell every domain anyone has
 * linked that you opened it.
 *
 * Because the sender resolved the page, the text is *their* view of it at
 * send time. It is deliberately not re-fetched or freshened.
 *
 * Two presentations, chosen by the Link previews preference in Appearance
 * settings (the desktop client's `LinkPreviewStyleSetting`, ported):
 *
 *  - Compact — a thumbnail beside the text. Several links in a row stay
 *    scannable and the timeline keeps its rhythm.
 *  - Rich — the image above the text at card width, description unclipped to
 *    three lines. Better for a single link worth looking at.
 *
 * Both keep a FIXED image box. The sender's image dimensions are not carried
 * in the tag, so a fluid box would reflow the timeline as each card's image
 * decodes — the same trap the attachment frames avoid.
 */
export function LinkPreviewCards({
  previews,
}: {
  previews: readonly LinkPreview[] | undefined;
}) {
  const style = useLinkPreviewStyle();

  // `previews` is typed as required and can still arrive undefined: messages
  // are persisted whole in IndexedDB (`lib/timelineCache.ts`), so an entry
  // written before this field existed comes back without it and TypeScript
  // never sees the gap. That crashed the whole app through the error boundary
  // until `CACHE_VERSION` was bumped; this guard is the half that keeps
  // working when the next added field's bump is forgotten.
  if (!previews || previews.length === 0) {
    return null;
  }
  const rich = style === "rich";
  return (
    <div
      className="mt-1.5 flex flex-col gap-1.5"
      data-link-preview-style={style}
      data-testid="link-preview-cards"
    >
      {previews.map((preview) => (
        <a
          key={preview.url}
          href={preview.url}
          target="_blank"
          rel="noreferrer noopener"
          className={
            rich
              ? "flex max-w-xl flex-col overflow-hidden rounded-md border border-border/70 bg-card/60 transition-colors hover:bg-accent/40"
              : "flex max-w-xl overflow-hidden rounded-md border border-border/70 bg-card/60 transition-colors hover:bg-accent/40"
          }
        >
          {preview.imageUrl && (
            <PreviewImage
              alt=""
              className={
                rich
                  ? "h-44 w-full shrink-0 object-cover"
                  : "h-20 w-20 shrink-0 object-cover"
              }
              url={preview.imageUrl}
            />
          )}
          <span className="min-w-0 flex-1 p-2.5">
            <span className="flex items-center gap-1.5">
              {preview.faviconUrl && (
                <PreviewImage
                  alt=""
                  className="size-3.5 shrink-0 rounded-sm"
                  url={preview.faviconUrl}
                />
              )}
              {preview.site && (
                <span className="truncate text-2xs text-muted-foreground">
                  {preview.site}
                </span>
              )}
            </span>
            {preview.title && (
              <span
                className={
                  rich
                    ? "mt-0.5 block text-sm font-medium"
                    : "mt-0.5 block truncate text-sm font-medium"
                }
              >
                {preview.title}
              </span>
            )}
            {preview.description && (
              <span
                className={
                  rich
                    ? "mt-0.5 line-clamp-3 block text-xs text-muted-foreground"
                    : "mt-0.5 line-clamp-2 block text-xs text-muted-foreground"
                }
              >
                {preview.description}
              </span>
            )}
          </span>
        </a>
      ))}
    </div>
  );
}
