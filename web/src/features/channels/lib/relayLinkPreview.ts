/**
 * Talking to the relay's link-preview unfurl.
 *
 * A browser cannot author a preview by itself: it cannot read a cross-origin
 * page, and the snapshot's image and favicon have to be blobs in this relay's
 * own media store before ingest will accept the tag. The relay does both and
 * hands back exactly the fields a snapshot tag needs.
 *
 * Contract, read off the Rust:
 *
 * - `crates/buzz-relay/src/api/link_preview.rs` — `POST /link-preview/unfurl`,
 *   body `{ "url": "<https URL>" }`. NIP-98 with a payload digest plus the
 *   optional `x-auth-tag` header, the same pair the Blossom and GIF paths
 *   already send.
 * - `200` with `{ url, title, site, description, image?, favicon? }`, where
 *   `url` is the requested URL echoed byte-for-byte (it has to appear verbatim
 *   in the message for ingest to accept the tag, so a normalised URL would be
 *   useless), and each asset is `{ url, sha256 }` on this relay's media origin.
 * - `204` when the page yields no usable preview — a normal outcome, not an
 *   error: the message sends with a plain link.
 * - `400` refused URL (not https, credentials, private address, …), `429`
 *   quota, `502` upstream failure, `503` capacity.
 * - `crates/buzz-relay/src/nip11.rs` — a relay that can do this advertises
 *   `link_preview: { unfurl }` and the `buzz-link-preview` extension. Absent
 *   means an older or upstream relay, and the composer must stay silent
 *   rather than offering a feature that will 404.
 */

import { getAuthTagJson } from "@/shared/lib/key-store";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  linkPreviewCapability,
  type LinkPreviewCapability,
  type RelayInfo,
} from "./linkPreviewCapability.ts";
import type { UnfurlResult } from "./linkPreviewSnapshot.ts";

export type { LinkPreviewCapability } from "./linkPreviewCapability.ts";

/**
 * Ask the relay for this relay's unfurl capability.
 *
 * Unauthenticated — NIP-11 is public — so the composer can decide whether the
 * feature exists before anyone types a link.
 */
export async function fetchLinkPreviewCapability(
  signal?: AbortSignal,
): Promise<LinkPreviewCapability | null> {
  const base = relayHttpBaseUrl().replace(/\/+$/, "");
  const response = await fetch(`${base}/info`, {
    headers: { Accept: "application/nostr+json" },
    signal,
  });
  if (!response.ok) {
    return null;
  }
  return linkPreviewCapability((await response.json()) as RelayInfo, base);
}

/** A refusal the composer can act on, distinguished from a transport failure. */
export class UnfurlError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UnfurlError";
    this.status = status;
  }
}

/**
 * Unfurl one URL. Resolves to `null` when the relay has nothing to show
 * (`204`), which is a normal outcome and not worth reporting to the author.
 */
export async function unfurlLink(
  unfurlPath: string,
  url: string,
  signal?: AbortSignal,
): Promise<UnfurlResult | null> {
  const base = relayHttpBaseUrl().replace(/\/+$/, "");
  const endpoint = `${base}${unfurlPath}`;
  const body = JSON.stringify({ url });
  const headers: Record<string, string> = {
    Authorization: await makeNip98AuthHeader(endpoint, "POST", { body }),
    "Content-Type": "application/json",
  };
  const authTag = getAuthTagJson();
  if (authTag) {
    headers["x-auth-tag"] = authTag;
  }
  const response = await fetch(endpoint, {
    body,
    headers,
    method: "POST",
    signal,
  });
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new UnfurlError(
      response.status,
      payload.error ?? `link preview failed (${response.status})`,
    );
  }
  const raw = (await response.json()) as Partial<UnfurlResult>;
  if (typeof raw.url !== "string" || typeof raw.title !== "string") {
    return null;
  }
  return {
    url: raw.url,
    title: raw.title,
    site: typeof raw.site === "string" ? raw.site : "",
    description: typeof raw.description === "string" ? raw.description : "",
    image: raw.image,
    favicon: raw.favicon,
  };
}
