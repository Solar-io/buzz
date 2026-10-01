import { useEffect, useState } from "react";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { isRelayMediaHref } from "@/shared/lib/linkOpen";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

/**
 * The `<img src>` for a kind-0 profile picture, or null for the identicon.
 *
 * Relay media is auth-gated, so it goes through the signed GET (an object
 * URL). Anything else is a plain `src`: a signed `fetch()` to a third-party
 * host would hand that host a NIP-98 header, needs CORS it rarely has, and is
 * refused by the web client's CSP `connect-src` (images load under `img-src`
 * instead). Same split as `CustomEmojiImage`. Call `onError` from the
 * `<img>` so a dead foreign URL falls back to the identicon.
 */
export function useAvatarSrc(picture: string | undefined): {
  src: string | null;
  onError: () => void;
} {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    if (!picture) {
      return;
    }
    if (!isRelayMediaHref(picture, relayHttpBaseUrl())) {
      setSrc(isDirectImageUrl(picture) ? picture : null);
      return;
    }
    fetchSignedMedia(picture)
      .then((url) => {
        if (!cancelled) {
          setSrc(url);
        }
      })
      .catch(() => {
        // Unavailable media falls back to the identicon.
      });
    return () => {
      cancelled = true;
    };
  }, [picture]);
  return { src, onError: () => setSrc(null) };
}

/** Only absolute https / data:image URLs are rendered directly. */
function isDirectImageUrl(value: string): boolean {
  if (value.startsWith("data:image/")) {
    return true;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
