import { useEffect, useState } from "react";

import {
  nip05Url,
  parseNip05,
  readNip05Response,
  type Nip05Status,
} from "./lib/nip05.ts";

/** Bound the check so a hung domain does not leave the badge spinning. */
const NIP05_TIMEOUT_MS = 6_000;

/**
 * Ask the domain whether it agrees with a `nip05` claim.
 *
 * The request is a plain cross-origin `GET` of a public document. It is
 * deliberately not authenticated and carries no credentials — this is the
 * user's browser asking a third-party domain a question about a public key,
 * and NIP-05 requires those endpoints to be CORS-open.
 *
 * A domain that does not answer yields `unreachable`, which the badge shows as
 * *unproven* rather than false. Only an explicit disagreement is `mismatch`.
 */
export function useNip05Status(
  claim: string | null | undefined,
  pubkey: string,
): Nip05Status {
  const [status, setStatus] = useState<Nip05Status>("none");
  const trimmed = claim?.trim() ?? "";

  useEffect(() => {
    const address = parseNip05(trimmed);
    if (address === null) {
      setStatus(trimmed.length === 0 ? "none" : "malformed");
      return;
    }
    let cancelled = false;
    setStatus("checking");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), NIP05_TIMEOUT_MS);

    void fetch(nip05Url(address), {
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          return "unreachable" as const;
        }
        const body: unknown = await response.json();
        return readNip05Response(body, address, pubkey);
      })
      .catch(() => "unreachable" as const)
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, pubkey]);

  return status;
}
