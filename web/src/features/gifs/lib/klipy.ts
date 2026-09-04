/**
 * Parsing for the relay's KLIPY GIF proxy. Pure — no fetch, no React.
 *
 * The relay keeps the provider credential and forwards a narrow, allowlisted
 * slice of KLIPY's response. Contract, read off the Rust:
 *
 * - `crates/buzz-relay/src/router.rs:76` mounts `POST /gifs/search` and
 *   `POST /gifs/share`.
 * - `crates/buzz-relay/src/api/gifs.rs:53` — the search request body is
 *   `{ query, customer_id, locale }`. Empty `query` means trending; `query`
 *   may be 0–200 chars, `customer_id` 1–128, `locale` 1–32
 *   (`validate_text`, gifs.rs:69).
 * - `crates/buzz-relay/src/api/gifs.rs:224` — the response is rebuilt as
 *   `{ result: true, data: <upstream data> }` and NOTHING else; an upstream
 *   `result != true` becomes a 502 rather than being forwarded. So a body that
 *   parses here is already a success.
 * - `crates/buzz-relay/src/nip11.rs:181` — a relay with GIF search configured
 *   advertises `supported_extensions: ["buzz-gif"]` plus
 *   `gif: { provider, search, share }`. Absent means the operator has not
 *   configured a provider and the tab must not appear.
 *
 * NOT paginated. `crates/buzz-relay/src/api/gifs.rs:245` hardcodes
 * `page=1, per_page=24`, and `SearchRequest` has no page field, so a client
 * cannot ask for page 2 — extra JSON fields are simply ignored by serde. One
 * search returns at most 24 GIFs. Paging would need a relay change.
 */

interface KlipyAsset {
  height?: number;
  size?: number;
  url?: string;
  width?: number;
}

interface KlipyFileSet {
  gif?: KlipyAsset;
  jpg?: KlipyAsset;
  webp?: KlipyAsset;
}

interface KlipyRawGif {
  file?: {
    hd?: KlipyFileSet;
    md?: KlipyFileSet;
    sm?: KlipyFileSet;
    xs?: KlipyFileSet;
  };
  id?: number;
  slug?: string;
  title?: string;
  type?: string;
}

export interface KlipySearchResponse {
  data?: { data?: KlipyRawGif[] };
  result?: boolean;
}

export type KlipyAssetRef = Required<KlipyAsset>;

export interface KlipyGif {
  id: number | null;
  /** Full-size animated GIF — what gets inserted into the message. */
  original: KlipyAssetRef;
  /** Small animated preview for the results grid. */
  preview: KlipyAssetRef;
  /** Static poster, when KLIPY exposes one. Used under reduced motion. */
  poster: KlipyAssetRef | null;
  slug: string;
  title: string;
}

export interface RelayGifInfo {
  gif?: { provider?: string; search?: string; share?: string };
  supported_extensions?: string[];
}

export interface RelayGifCapability {
  provider: string;
  searchPath: string;
  sharePath: string;
}

/**
 * A relay-advertised path is only usable if it is a plain absolute path.
 * The relay controls this document, but it is still remote input that this
 * client is about to turn into a URL it signs a NIP-98 event for — a
 * protocol-relative `//evil.example` or an escape sequence must not get there.
 */
function safeRelayPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !path.includes("%") &&
    !path.includes("?") &&
    !path.includes("#") &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/** The relay's GIF endpoints, or null when it advertises none. */
export function relayGifCapability(
  info: RelayGifInfo,
): RelayGifCapability | null {
  const searchPath = info.gif?.search;
  const sharePath = info.gif?.share;
  const provider = info.gif?.provider;
  if (
    info.supported_extensions?.includes("buzz-gif") === true &&
    typeof provider === "string" &&
    provider.length > 0 &&
    safeRelayPath(searchPath) &&
    safeRelayPath(sharePath)
  ) {
    return { provider, searchPath, sharePath };
  }
  return null;
}

function isCompleteAsset(
  asset: KlipyAsset | undefined,
): asset is KlipyAssetRef {
  return (
    typeof asset?.url === "string" &&
    asset.url.length > 0 &&
    typeof asset.width === "number" &&
    typeof asset.height === "number" &&
    typeof asset.size === "number"
  );
}

function firstCompleteAsset(
  ...assets: Array<KlipyAsset | undefined>
): KlipyAssetRef | null {
  return assets.find(isCompleteAsset) ?? null;
}

/**
 * Normalize KLIPY's mixed media list to GIF-only results.
 *
 * The provider interleaves ad/content records that carry no `file` payload;
 * those are dropped rather than rendered, matching the desktop client — Buzz
 * has no third-party ad surface, and a record with no usable asset would be a
 * blank tile.
 */
export function normalizeKlipyGifs(
  items: ReadonlyArray<KlipyRawGif>,
): KlipyGif[] {
  const gifs: KlipyGif[] = [];
  for (const item of items) {
    if (item.type !== "gif" || !item.file || !item.slug) {
      continue;
    }
    const original = firstCompleteAsset(
      item.file.md?.gif,
      item.file.hd?.gif,
      item.file.sm?.gif,
      item.file.xs?.gif,
    );
    const preview = firstCompleteAsset(
      item.file.sm?.webp,
      item.file.sm?.gif,
      item.file.xs?.webp,
      item.file.xs?.gif,
      item.file.md?.webp,
      original ?? undefined,
    );
    if (!original || !preview) {
      continue;
    }
    gifs.push({
      id: item.id ?? null,
      original,
      preview,
      poster: firstCompleteAsset(
        item.file.sm?.jpg,
        item.file.xs?.jpg,
        item.file.md?.jpg,
        item.file.hd?.jpg,
      ),
      slug: item.slug,
      title: item.title?.trim() || "GIF",
    });
  }
  return gifs;
}

/** Pull the GIF list out of a relay search response. */
export function gifsFromSearchResponse(
  response: KlipySearchResponse,
): KlipyGif[] {
  if (response.result === false) {
    return [];
  }
  return normalizeKlipyGifs(response.data?.data ?? []);
}

/** Filename a shared GIF is labelled with in the composer. */
export function klipyGifFilename(gif: KlipyGif): string {
  const safeSlug = gif.slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safeSlug || "klipy-gif"}.gif`;
}

/**
 * The markdown a chosen GIF becomes in the composer.
 *
 * Deliberately just an image link, with NO imeta tag: the GIF is hosted on
 * KLIPY's CDN, and the relay only accepts imeta entries for media it verified
 * itself — `crates/buzz-relay/src/handlers/imeta.rs:62` rejects an imeta whose
 * url is not a local `/media/` path. The existing message
 * image path renders the URL, so no receiving-side change is needed.
 */
export function gifMarkdown(gif: KlipyGif): string {
  return `![${gif.title}](${gif.original.url})`;
}

/* ---------------------------------------------------------------------------
 * Request inputs and error text.
 *
 * These live beside the parsing rather than in ./relay.ts so they can be
 * exercised without a relay, a signer, or a browser: relay.ts imports the
 * app's key store and NIP-98 signer, which cannot be loaded in a bare node
 * test run.
 * ------------------------------------------------------------------------- */

const CUSTOMER_ID_STORAGE_KEY = "buzz:klipy-customer-id:v1";

/**
 * KLIPY requires a stable anonymous installation id so it can keep "recents"
 * per user without knowing who the user is. Persisted per origin; where
 * storage is unavailable (private mode, hardened webview) a fresh id per call
 * is better than a shared constant, which would correlate every visitor.
 */
export function klipyCustomerId(
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
): string {
  if (!storage) {
    return crypto.randomUUID();
  }
  try {
    const existing = storage.getItem(CUSTOMER_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const created = crypto.randomUUID();
    storage.setItem(CUSTOMER_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Relay error bodies that deserve a human sentence rather than a code. */
const FRIENDLY_ERRORS: Record<string, string> = {
  relay_membership_required: "Join this community to search GIFs.",
};

export function gifErrorMessage(
  error: string | undefined,
  status: number,
): string {
  if (error && FRIENDLY_ERRORS[error]) {
    return FRIENDLY_ERRORS[error];
  }
  if (status === 404) {
    return "This relay has no GIF provider configured.";
  }
  if (status === 429) {
    return "GIF search is rate limited — try again shortly.";
  }
  return error || `GIF request failed (${status})`;
}
