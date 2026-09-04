/**
 * Which signer is active, as a *reactive* value.
 *
 * `activeSignerSource()` is a plain function over module state, and the key
 * store fills that state ASYNCHRONOUSLY: `initKeyStore()` reads IndexedDB after
 * the first render, so on a page load with a remembered key the first call
 * returns "extension" (or "ephemeral") and only later becomes "local".
 *
 * A component that calls it once at mount and never re-renders is therefore
 * wrong for the entire life of the page. That is not hypothetical — it was
 * caught in a browser on 2026-09-04: the Key backup card rendered its "you use
 * an extension" branch for a device whose key was sitting right there in
 * IndexedDB, and the setup checklist dropped its one CRITICAL item ("back up
 * your key") for exactly the users who most needed it. Both looked completely
 * healthy; the only tell was the neighbouring "This device" section, which
 * subscribes to auth state and so said "Key stored on this device".
 *
 * Subscribing to the key store's own emitter fixes it at the source, and this
 * hook exists so no future caller has to remember the hazard.
 */

import { useSyncExternalStore } from "react";

import { subscribeAuth } from "@/shared/lib/key-store";
import { activeSignerSource } from "@/shared/lib/nostr-signer";

/**
 * `subscribeAuth` fires on every auth-state transition, and
 * `activeSignerSource` returns a primitive, so `useSyncExternalStore` can use
 * it directly as the snapshot without a cache.
 */
export function useSignerSource(): "local" | "extension" | "ephemeral" {
  return useSyncExternalStore(
    subscribeAuth,
    activeSignerSource,
    activeSignerSource,
  );
}
