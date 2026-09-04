import { useEffect, useState } from "react";

import { fetchSignedMedia } from "@/shared/api/blossom";
import { cn } from "@/shared/lib/cn";
import { isRelayMediaHref } from "@/shared/lib/linkOpen";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

/**
 * One custom emoji rendered as an inline image.
 *
 * Sized in `em` so it tracks whatever text it sits in — message body, reaction
 * chip, picker cell — and follows Cmd +/- zoom for free, since the surrounding
 * font-size is rem-based.
 *
 * The `alt` is the literal `:shortcode:`. That is the NIP-30 fallback: a
 * reader whose image fails to load, or who copies the text out, gets the same
 * thing every other client would show them.
 *
 * RELAY-HOSTED EMOJI NEED A SIGNED GET. `GET /media/{sha256}` runs
 * `authenticate_media_read` (crates/buzz-relay/src/api/media.rs), and an
 * `<img>` element cannot sign a NIP-98 header — so a plain `src` on a relay
 * URL renders a broken image, which is exactly what every emoji uploaded
 * through the new settings card would have done. Those go through
 * `fetchSignedMedia`, which caches one object URL per source URL across the
 * app, so a palette repeated down a timeline costs one request. Emoji hosted
 * anywhere else keep the plain `src` and stay a single paint with no fetch.
 */
export function CustomEmojiImage({
  shortcode,
  url,
  className,
}: {
  shortcode: string;
  url: string;
  className?: string;
}) {
  const needsSignedGet = isRelayMediaHref(url, relayHttpBaseUrl());
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  useEffect(() => {
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
        // Leave the alt text standing rather than an error state: a missing
        // emoji must never take a message row down with it.
      });
    return () => {
      cancelled = true;
    };
  }, [needsSignedGet, url]);

  const src = needsSignedGet ? signedUrl : url;
  if (!src) {
    // Reserve the same box the image will occupy so the line does not reflow
    // when the signed fetch lands.
    return (
      <span
        aria-label={`:${shortcode}:`}
        className={cn(
          "inline-block h-[1.375em] w-[1.375em] align-[-0.3em]",
          className,
        )}
        data-custom-emoji={shortcode}
        data-custom-emoji-pending="true"
        role="img"
      />
    );
  }

  return (
    <img
      src={src}
      alt={`:${shortcode}:`}
      title={`:${shortcode}:`}
      loading="lazy"
      decoding="async"
      draggable={false}
      data-custom-emoji={shortcode}
      className={cn(
        "inline-block h-[1.375em] w-[1.375em] object-contain align-[-0.3em]",
        className,
      )}
    />
  );
}
