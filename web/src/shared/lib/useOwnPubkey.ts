import { useEffect, useState } from "react";
import { subscribeAuth } from "./key-store";
import { ownPubkey } from "./nostr-signer";

/**
 * The viewer's own pubkey, re-resolved whenever the auth store says it changed.
 *
 * `ownPubkey()` is async but reads *synchronous* module state that
 * `initKeyStore()` fills in from IndexedDB after mount. So a component that
 * calls it once at mount can resolve `null` and never ask again — and the
 * failure is silent, because a component with no pubkey usually renders a
 * plausible empty state rather than an error.
 *
 * That has now been measured three separate times in this codebase, each time
 * hiding from exactly the person it mattered to: the key backup card told a
 * device holding its own key that it was signing with an extension and offered
 * no backup; the setup checklist dropped its one critical item; and the custom
 * emoji card said "you have not added any emoji yet" while the caller's own
 * emoji sat in the community list.
 *
 * `subscribeAuth` is the store's own signal that the answer changed. It also
 * makes signing out and back in as someone else return the new key rather than
 * the previous account's.
 */
export function useOwnPubkey(): string | null {
  const [pubkey, setPubkey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const resolve = () => {
      void ownPubkey().then((value) => {
        if (!cancelled) {
          setPubkey(value);
        }
      });
    };
    resolve();
    const unsubscribe = subscribeAuth(resolve);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return pubkey;
}
