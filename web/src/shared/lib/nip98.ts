/**
 * NIP-98 HTTP Auth helper — signs a kind:27235 event for authenticating
 * HTTP requests to the relay (used by isomorphic-git for smart HTTP transport).
 */

import { getAuthTagJson } from "./key-store";
import { signNostrEvent } from "./nostr-signer";
import { buildNip98Tags } from "./nip98Tags.ts";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a NIP-98 Authorization header value.
 *
 * Signed POST bodies include the payload digest required by invite endpoints.
 * Every request carries a nonce so repeats of the same URL stay distinct.
 */
export async function makeNip98AuthHeader(
  url: string,
  method: string,
  options?: { body?: string; requireNip07?: boolean },
): Promise<string> {
  const tags = buildNip98Tags(
    url,
    method,
    options?.body === undefined ? undefined : await sha256Hex(options.body),
    crypto.randomUUID(),
  );
  const event = await signNostrEvent(
    {
      kind: 27235,
      tags,
      content: "",
    },
    { requireNip07: options?.requireNip07 },
  );

  const json = JSON.stringify(event);
  const base64 = btoa(json);
  return `Nostr ${base64}`;
}

/**
 * Every header an authenticated relay HTTP request needs.
 *
 * Prefer this over calling {@link makeNip98AuthHeader} directly. `x-auth-tag`
 * is not part of the NIP-98 event — it is a separate header the relay reads on
 * every bridge route, and it does two jobs: `enforce_relay_membership` uses it
 * to admit a member whose membership is tag-scoped, and the moderation routes
 * additionally use it for the NIP-OA **owner** fallback
 * (`extract_nip_oa_owner`). Omitting it therefore does not merely risk a 403 —
 * it can make the relay unable to see that the caller is the owner at all.
 *
 * That was worth making structural rather than remembered: a sweep on
 * 2026-09-04 found seven of ten NIP-98 callers omitting it, and the failure is
 * a bare 403 with no hint about which header is missing.
 */
export async function nip98Headers(
  url: string,
  method: string,
  options?: { body?: string; requireNip07?: boolean },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    authorization: await makeNip98AuthHeader(url, method, options),
  };
  if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const authTag = getAuthTagJson();
  if (authTag) {
    headers["x-auth-tag"] = authTag;
  }
  return headers;
}
