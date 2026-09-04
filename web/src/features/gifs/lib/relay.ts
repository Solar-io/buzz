/**
 * Talking to the relay's KLIPY proxy.
 *
 * Both endpoints are NIP-98 authenticated POSTs with a payload digest
 * (`crates/buzz-relay/src/api/gifs.rs:117` calls
 * `verify_bridge_auth_with_options(.., Some(body), true, true)`), and both go
 * on to `enforce_relay_membership`, which reads the optional `x-auth-tag`
 * header — the same pair the Blossom upload path already sends.
 */

import { getAuthTagJson } from "@/shared/lib/key-store";
import { nip98Headers } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  gifErrorMessage,
  gifsFromSearchResponse,
  klipyCustomerId,
  relayGifCapability,
  type KlipyGif,
  type KlipySearchResponse,
  type RelayGifCapability,
  type RelayGifInfo,
} from "./klipy.ts";

async function relayPost<T>(
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}${path}`;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    ...(await nip98Headers(url, "POST", { body })),
  };
  const authTag = getAuthTagJson();
  if (authTag) {
    headers["x-auth-tag"] = authTag;
  }
  const response = await fetch(url, { body, headers, method: "POST", signal });
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(gifErrorMessage(json.error, response.status));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * The relay's advertised GIF endpoints, or null when it has no provider.
 *
 * Unauthenticated: NIP-11 is public, so this can run before the picker is ever
 * opened and decide whether the GIF tab exists at all.
 */
export async function fetchRelayGifCapability(
  signal?: AbortSignal,
): Promise<RelayGifCapability | null> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/info`;
  const response = await fetch(url, {
    headers: { Accept: "application/nostr+json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Could not read relay capabilities (${response.status})`);
  }
  return relayGifCapability((await response.json()) as RelayGifInfo);
}

/**
 * Search, or browse trending when `query` is empty — the relay switches
 * endpoints on exactly that (`api/gifs.rs:238`).
 */
export async function searchGifs(
  searchPath: string,
  query: string,
  signal?: AbortSignal,
): Promise<KlipyGif[]> {
  const response = await relayPost<KlipySearchResponse>(
    searchPath,
    {
      customer_id: klipyCustomerId(),
      locale: navigator.language || "en-US",
      // The relay caps `query` at 200 chars and 400s anything longer, so a
      // pasted essay must be trimmed here rather than becoming an error.
      query: query.trim().slice(0, 200),
    },
    signal,
  );
  return gifsFromSearchResponse(response);
}

/**
 * Tell the provider a GIF was actually sent, so its "recents" stay useful.
 * Best-effort: a failure here must never block the message.
 */
export async function reportGifShare(
  sharePath: string,
  slug: string,
): Promise<void> {
  try {
    await relayPost<void>(sharePath, {
      customer_id: klipyCustomerId(),
      slug,
    });
  } catch {
    // Intentionally ignored — reporting a share is provider bookkeeping.
  }
}
