import { useEffect, useState } from "react";

import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

/**
 * The relay's own signing key, from its NIP-11 document's `self` field
 * (lowercase hex), or null when the relay advertises none or the read fails.
 *
 * Anything that trusts an event BECAUSE the relay signed it (NIP-IA archive
 * snapshots, `buzz-system` messages such as the huddle call transcript) must
 * compare the event's author against this — a tag alone is forgeable.
 *
 * Cached per page: it identifies the relay, and it does not change under a
 * running tab.
 */
let relaySelfPromise: Promise<string | null> | null = null;
/** The settled value, so late mounts render with it on their first paint. */
let relaySelfSettled: string | null | undefined;

export function fetchRelaySelf(): Promise<string | null> {
  relaySelfPromise ??= (async () => {
    try {
      const response = await fetch(relayHttpBaseUrl(), {
        headers: { Accept: "application/nostr+json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const document = (await response.json()) as Record<string, unknown>;
      const self = document.self;
      return typeof self === "string" && /^[0-9a-f]{64}$/i.test(self)
        ? self.toLowerCase()
        : null;
    } catch {
      return null;
    }
  })().then((self) => {
    relaySelfSettled = self;
    return self;
  });
  return relaySelfPromise;
}

/**
 * {@link fetchRelaySelf} as a hook. `enabled=false` skips the NIP-11 read
 * (rows that do not need the relay key never trigger it) and returns null.
 */
export function useRelaySelf(enabled = true): string | null {
  const [self, setSelf] = useState<string | null>(() =>
    enabled ? (relaySelfSettled ?? null) : null,
  );
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchRelaySelf().then((value) => {
      if (live) setSelf(value);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? self : null;
}
