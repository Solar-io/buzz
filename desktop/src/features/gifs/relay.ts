import {
  type KlipyGif,
  type KlipyResponse,
  normalizeKlipyGifs,
  type RelayGifSearchInfo,
  relayKlipySearchPath,
} from "@/features/gifs/api";
import { relayHttpFromWs } from "@/shared/api/inviteHelpers";
import { signRelayEvent } from "@/shared/api/tauri";

const KLIPY_CUSTOMER_ID_STORAGE_KEY = "buzz:klipy-customer-id:v1";
const NIP98_KIND = 27235;

function customerId(): string {
  if (typeof window === "undefined") return "buzz-desktop";

  try {
    const existing = window.localStorage.getItem(KLIPY_CUSTOMER_ID_STORAGE_KEY);
    if (existing) return existing;

    const created = globalThis.crypto.randomUUID();
    window.localStorage.setItem(KLIPY_CUSTOMER_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return "buzz-desktop";
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function nip98PostHeader(url: string, body: string): Promise<string> {
  const authEvent = await signRelayEvent({
    kind: NIP98_KIND,
    content: "",
    tags: [
      ["u", url],
      ["method", "POST"],
      ["payload", await sha256Hex(body)],
      ["nonce", crypto.randomUUID()],
    ],
  });
  return `Nostr ${btoa(JSON.stringify(authEvent))}`;
}

async function relayPost<T>(
  relayUrl: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${relayHttpFromWs(relayUrl).replace(/\/+$/, "")}${path}`;
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    body,
    headers: {
      Authorization: await nip98PostHeader(url, body),
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(json.error || `GIF request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The selected relay's advertised KLIPY search path, when supported. */
export async function relayKlipySearchEndpoint(
  relayUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `${relayHttpFromWs(relayUrl).replace(/\/+$/, "")}/info`;
  const response = await fetch(url, {
    headers: { Accept: "application/nostr+json" },
    signal,
  });
  if (!response.ok)
    throw new Error(`Could not read relay capabilities (${response.status})`);
  const info = (await response.json()) as RelayGifSearchInfo;
  return relayKlipySearchPath(info);
}

/** Search KLIPY through the selected relay without exposing its provider key. */
export async function fetchKlipyGifs(
  relayUrl: string,
  searchPath: string,
  query: string,
  signal?: AbortSignal,
): Promise<KlipyGif[]> {
  const response = await relayPost<KlipyResponse>(
    relayUrl,
    searchPath,
    {
      customer_id: customerId(),
      locale: navigator.language || "en-US",
      query: query.trim(),
    },
    signal,
  );
  if (response.result === false) {
    throw new Error("GIF search failed");
  }
  return normalizeKlipyGifs(response.data?.data ?? []);
}
