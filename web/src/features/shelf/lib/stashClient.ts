/**
 * The stash editor API, as the Canvas file pane uses it (canvas edit plan
 * `~/.buzz/PLANS/CANVAS_EDIT_AGENT_BOX.md` §6): `locate` an absolute path to
 * stash's `(root, rel)` address, `readFile` it (304 while unchanged), and
 * `saveFile` it behind the digest precondition.
 *
 * Every call rides Sam's stash session cookie (`credentials: "include"`;
 * stash's cookie is `SameSite=None; Secure`), and stash answers these three
 * routes — and only these — with CORS for this origin. A PUT sends
 * `Content-Type: application/json`, which stash's CSRF gate requires (415
 * otherwise).
 *
 * Forgiving like hatchClient.ts: every outcome is a typed value, never a
 * thrown error. A network error, a CORS refusal, a timeout or a body that is
 * not the shape we know is "unreachable".
 */

export interface StashAddress {
  root: string;
  rel: string;
}

export interface StashDoc {
  content: string;
  digest: string;
  mtimeMs: number;
  size: number;
  /** The bytes do not survive a JS string round trip: open read-only. */
  lossy: boolean;
}

export type LocateResult =
  | { kind: "ok"; address: StashAddress }
  /** The path is a folder (nothing to edit). */
  | { kind: "not-editable" }
  | { kind: "signed-out" }
  /** 403: outside the roots, read-denied, or an account stash refuses. */
  | { kind: "forbidden"; reason: string | null }
  | { kind: "gone" }
  | { kind: "unreachable" };

export type ReadResult =
  | { kind: "ok"; doc: StashDoc }
  | { kind: "not-modified" }
  | { kind: "not-editable" }
  | { kind: "too-large" }
  | { kind: "gone" }
  | { kind: "signed-out" }
  | { kind: "forbidden"; reason: string | null }
  | { kind: "unreachable" };

export type SaveResult =
  | { kind: "ok"; digest: string; mtimeMs: number; size: number }
  /** 409: the disk moved on since the digest we sent. The current state. */
  | {
      kind: "conflict";
      digest: string;
      mtimeMs: number | null;
      size: number | null;
    }
  /** 409 with no current digest: the file was deleted after load. */
  | { kind: "gone" }
  | { kind: "not-editable" }
  | { kind: "too-large" }
  | { kind: "signed-out" }
  | { kind: "forbidden"; reason: string | null }
  | { kind: "unreachable" };

export const STASH_TIMEOUT_MS = 10_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const DIGEST = /^[0-9a-f]{64}$/;

/** `https://host:6831/` + `api/browser/x` — tolerant of a missing slash. */
export function stashUrl(
  filesUrl: string,
  route: string,
  query: Record<string, string> = {},
): string {
  const base = filesUrl.endsWith("/") ? filesUrl : `${filesUrl}/`;
  const url = new URL(route.replace(/^\//, ""), base);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

type Fetch = typeof fetch;

async function call(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), STASH_TIMEOUT_MS)
    : null;
  try {
    return await fetchImpl(url, {
      ...init,
      credentials: "include",
      cache: "no-store",
      signal: controller?.signal,
    });
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function body(res: Response): Promise<Rec | null> {
  try {
    const value: unknown = await res.json();
    return isRec(value) ? value : null;
  } catch {
    return null;
  }
}

/** 401 / 403 / 404 — the refusals every route shares. */
async function refusal(
  res: Response,
): Promise<
  | { kind: "signed-out" }
  | { kind: "forbidden"; reason: string | null }
  | { kind: "gone" }
  | null
> {
  if (res.status === 401) {
    return { kind: "signed-out" };
  }
  if (res.status === 403) {
    const b = await body(res);
    return {
      kind: "forbidden",
      reason: str(b?.reason) ?? str(b?.error) ?? null,
    };
  }
  if (res.status === 404) {
    return { kind: "gone" };
  }
  return null;
}

export function parseDoc(raw: unknown): StashDoc | null {
  if (!isRec(raw)) {
    return null;
  }
  const content = str(raw.content);
  const digest = str(raw.digest);
  const mtimeMs = num(raw.mtimeMs);
  const size = num(raw.size);
  if (
    content === null ||
    digest === null ||
    !DIGEST.test(digest) ||
    mtimeMs === null ||
    size === null
  ) {
    return null;
  }
  return { content, digest, mtimeMs, size, lossy: raw.lossy === true };
}

export async function locate(
  filesUrl: string,
  abs: string,
  fetchImpl: Fetch = fetch,
): Promise<LocateResult> {
  const res = await call(
    fetchImpl,
    stashUrl(filesUrl, "api/browser/locate", { abs }),
  );
  if (!res) {
    return { kind: "unreachable" };
  }
  const refused = await refusal(res);
  if (refused) {
    return refused;
  }
  if (!res.ok) {
    return { kind: "unreachable" };
  }
  const b = await body(res);
  const root = str(b?.root);
  const rel = str(b?.rel);
  if (root === null || rel === null) {
    return { kind: "unreachable" };
  }
  if (b?.dir === true) {
    return { kind: "not-editable" };
  }
  return { kind: "ok", address: { root, rel } };
}

export async function readFile(
  filesUrl: string,
  address: StashAddress,
  knownMtime: number | null = null,
  fetchImpl: Fetch = fetch,
): Promise<ReadResult> {
  const query: Record<string, string> = {
    root: address.root,
    path: address.rel,
  };
  if (knownMtime !== null) {
    query.mtimeMs = String(knownMtime);
  }
  const res = await call(
    fetchImpl,
    stashUrl(filesUrl, "api/browser/file", query),
  );
  if (!res) {
    return { kind: "unreachable" };
  }
  if (res.status === 304) {
    return { kind: "not-modified" };
  }
  const refused = await refusal(res);
  if (refused) {
    return refused;
  }
  if (res.status === 413) {
    return { kind: "too-large" };
  }
  if (res.status === 415) {
    return { kind: "not-editable" };
  }
  if (!res.ok) {
    return { kind: "unreachable" };
  }
  const doc = parseDoc(await body(res));
  return doc ? { kind: "ok", doc } : { kind: "unreachable" };
}

export async function saveFile(
  filesUrl: string,
  address: StashAddress,
  content: string,
  digest: string,
  fetchImpl: Fetch = fetch,
): Promise<SaveResult> {
  const res = await call(fetchImpl, stashUrl(filesUrl, "api/browser/file"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: address.root,
      path: address.rel,
      content,
      digest,
    }),
  });
  if (!res) {
    return { kind: "unreachable" };
  }
  if (res.status === 409) {
    const b = await body(res);
    const current = str(b?.digest);
    if (current === null || !DIGEST.test(current)) {
      return { kind: "gone" };
    }
    return {
      kind: "conflict",
      digest: current,
      mtimeMs: num(b?.mtimeMs),
      size: num(b?.size),
    };
  }
  const refused = await refusal(res);
  if (refused) {
    return refused;
  }
  if (res.status === 413) {
    return { kind: "too-large" };
  }
  if (res.status === 415) {
    return { kind: "not-editable" };
  }
  if (!res.ok) {
    return { kind: "unreachable" };
  }
  const b = await body(res);
  const saved = str(b?.digest);
  const mtimeMs = num(b?.mtimeMs);
  const size = num(b?.size);
  if (saved === null || mtimeMs === null || size === null) {
    return { kind: "unreachable" };
  }
  return { kind: "ok", digest: saved, mtimeMs, size };
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes (stash's digest). */
export async function sha256Hex(text: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(text);
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}
