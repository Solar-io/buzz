/**
 * React glue for the relay's GIF proxy.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchRelayGifCapability } from "./lib/relay.ts";
import type { RelayGifCapability } from "./lib/klipy.ts";

/**
 * Whether this relay offers GIF search at all.
 *
 * NIP-11 is public and cacheable, so this runs whether or not the picker is
 * open and decides whether the GIF tab exists. A relay with no provider
 * configured returns null and the tab is simply absent — the alternative, a
 * tab that always errors, is worse than no tab. A network failure also yields
 * null (`retry: false`): a missing capability document is indistinguishable
 * from an unconfigured relay from here, and neither is worth a red banner in a
 * picker the user opened to choose an emoji.
 */
export function useGifCapability(): RelayGifCapability | null {
  const capability = useQuery({
    queryKey: ["gif-capability"],
    queryFn: ({ signal }) => fetchRelayGifCapability(signal),
    retry: false,
    staleTime: 30 * 60_000,
  });
  return capability.data ?? null;
}

/**
 * `prefers-reduced-motion: reduce`, live.
 *
 * Used to swap animated previews for static posters. Doing this in JS rather
 * than with a `motion-reduce:` class is deliberate: a CSS-hidden `<img>` is
 * still fetched, so a reduced-motion reader would download two dozen animated
 * GIFs in order not to look at them.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchReducedMotion());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function matchReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
