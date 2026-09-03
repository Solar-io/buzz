import type { LinkPreview } from "../lib/linkPreview.ts";

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
 */
export function LinkPreviewCards({
  previews,
}: {
  previews: readonly LinkPreview[];
}) {
  if (previews.length === 0) {
    return null;
  }
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {previews.map((preview) => (
        <a
          key={preview.url}
          href={preview.url}
          target="_blank"
          rel="noreferrer noopener"
          className="flex max-w-xl overflow-hidden rounded-md border border-border/70 bg-card/60 transition-colors hover:bg-accent/40"
        >
          {preview.imageUrl && (
            <img
              src={preview.imageUrl}
              alt=""
              loading="lazy"
              /* Fixed box: the sender's image dimensions are not carried in
                 the tag, so a fluid one would reflow the timeline as cards
                 load — the same trap the attachment frames avoid. */
              className="h-20 w-20 shrink-0 object-cover"
            />
          )}
          <span className="min-w-0 flex-1 p-2.5">
            <span className="flex items-center gap-1.5">
              {preview.faviconUrl && (
                <img
                  src={preview.faviconUrl}
                  alt=""
                  loading="lazy"
                  className="size-3.5 shrink-0 rounded-sm"
                />
              )}
              {preview.site && (
                <span className="truncate text-2xs text-muted-foreground">
                  {preview.site}
                </span>
              )}
            </span>
            {preview.title && (
              <span className="mt-0.5 block truncate text-sm font-medium">
                {preview.title}
              </span>
            )}
            {preview.description && (
              <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                {preview.description}
              </span>
            )}
          </span>
        </a>
      ))}
    </div>
  );
}
