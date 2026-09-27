import { useEffect, useState } from "react";
import { fetchStageMedia } from "@/features/stage/lib/stageMedia";

/**
 * Object URL for a relay media URL (signed GET — `<img src>` cannot sign).
 * Shares `fetchSignedMedia`'s app-wide cache with timeline rows and the
 * Stage preloader, so a frame fetched once is never fetched again.
 */
export function useStageImage(url: string | null | undefined): {
  objectUrl: string | null;
  failed: boolean;
} {
  const [state, setState] = useState<{
    url: string | null;
    objectUrl: string | null;
    failed: boolean;
  }>({ url: null, objectUrl: null, failed: false });

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetchStageMedia(url)
      .then((objectUrl) => {
        if (!cancelled) setState({ url, objectUrl, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url, objectUrl: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Never hand back the previous URL's bitmap for a new URL.
  if (!url || state.url !== url) return { objectUrl: null, failed: false };
  return { objectUrl: state.objectUrl, failed: state.failed };
}
