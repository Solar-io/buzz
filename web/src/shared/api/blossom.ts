/**
 * Blossom media (BUD-02 upload, signed GET) for the browser client.
 *
 * Mirrors the CLI's wire shapes exactly (crates/buzz-cli/src/client.rs):
 * - PUT {http}/upload, Authorization: Nostr <b64url-nopad(kind 24242 event)>,
 *   Content-Type, X-SHA-256; agents additionally send x-auth-tag.
 * - GET media URLs with a kind 24242 "Get media" auth header; <img> tags
 *   cannot sign, so media is fetched as blobs and rendered from object URLs.
 */

import type { SignedNostrEvent } from "../lib/nostr-signer";
import { signNostrEvent } from "../lib/nostr-signer";
import { getAuthTagJson } from "../lib/key-store";
import { relayHttpBaseUrl } from "../lib/relay-url";
import { canonicalizeImage } from "../lib/mediaCanonical";

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export const ALLOWED_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
] as const;

export interface BlobDescriptor {
  url: string;
  sha256: string;
  mime_type: string;
  size: number;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
}

function toBase64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function serverDomain(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function buildAuthorization(
  action: "upload" | "get",
  extras: { sha256?: string; content: string; targetUrl: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + (action === "upload" ? 600 : 600);
  const tags: string[][] = [["t", action]];
  if (extras.sha256) {
    tags.push(["x", extras.sha256]);
  }
  tags.push(["expiration", String(expiry)]);
  const domain = serverDomain(extras.targetUrl);
  if (domain) {
    tags.push(["server", domain]);
  }
  const event: SignedNostrEvent = await signNostrEvent({
    kind: 24242,
    tags,
    content: extras.content,
  });
  return `Nostr ${toBase64UrlNoPad(new TextEncoder().encode(JSON.stringify(event)))}`;
}

/** Sniff a subset of the CLI's magic-byte checks; fall back to file.type. */
export function detectMime(file: File): string | null {
  if (file.type && (ALLOWED_MIMES as readonly string[]).includes(file.type)) {
    return file.type;
  }
  // Browsers reliably label the allowed set; anything else is rejected.
  return null;
}

export function maxBytesFor(mime: string): number {
  return mime.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

/**
 * Re-encode JPEG/PNG through a canvas: strips EXIF by construction and caps
 * phone-camera dimensions. GIF (animation) and WebP pass through untouched —
 * the relay's own pipeline handles their metadata.
 */
export async function prepareForUpload(file: File): Promise<File> {
  if (file.type !== "image/jpeg" && file.type !== "image/png") {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 2560;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type),
    );
    if (!blob || blob.size >= file.size) {
      // Re-encode grew it or failed — send the original.
      return file;
    }
    return new File([blob], file.name, { type: file.type });
  } catch {
    return file;
  }
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
}

/** Upload a file via BUD-02. Returns the relay's blob descriptor. */
export async function uploadBlob(
  file: File,
  options: UploadOptions = {},
): Promise<BlobDescriptor> {
  const prepared = await prepareForUpload(file);
  const mime = detectMime(prepared);
  if (!mime) {
    throw new Error(
      `Unsupported file type (${prepared.type || "unknown"}) — images and MP4 only.`,
    );
  }
  if (prepared.size > maxBytesFor(mime)) {
    throw new Error("File is too large.");
  }
  let bytes = new Uint8Array(await prepared.arrayBuffer());
  const canonical = canonicalizeImage(bytes, mime);
  if (canonical) {
    bytes = new Uint8Array(canonical);
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

  const base = relayHttpBaseUrl().replace(/\/$/, "");
  const targets = [`${base}/upload`, `${base}/media/upload`];

  let lastError = "upload failed";
  for (const url of targets) {
    const authorization = await buildAuthorization("upload", {
      sha256,
      content: "Upload file",
      targetUrl: url,
    });
    const headers: Record<string, string> = {
      Authorization: authorization,
      "Content-Type": mime,
      "X-SHA-256": sha256,
    };
    const authTag = getAuthTagJson();
    if (authTag) {
      headers["x-auth-tag"] = authTag;
    }
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: bytes,
    });
    options.onProgress?.(1);
    if (response.status === 404 || response.status === 405) {
      lastError = `endpoint ${url} unavailable`;
      continue;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Upload rejected (${response.status}): ${body.slice(0, 200)}`,
      );
    }
    const raw = (await response.json()) as Partial<BlobDescriptor> & {
      type?: string;
    };
    // The relay's wire shape uses "type"; normalize to mime_type.
    const descriptor: BlobDescriptor = {
      url: String(raw.url ?? ""),
      sha256: String(raw.sha256 ?? ""),
      mime_type: String(raw.mime_type ?? raw.type ?? ""),
      size: Number(raw.size ?? 0),
      dim: raw.dim,
      blurhash: raw.blurhash,
      thumb: raw.thumb,
      duration: raw.duration,
    };
    if (!descriptor.url || !descriptor.mime_type) {
      throw new Error("Upload response was missing url or type.");
    }
    return descriptor;
  }
  throw new Error(lastError);
}

/** Object URLs for signed media GETs, deduped across the app. */
const objectUrlCache = new Map<string, string>();

/** Fetch a media URL with a signed GET and cache its object URL. */
export async function fetchSignedMedia(url: string): Promise<string> {
  const cached = objectUrlCache.get(url);
  if (cached) {
    return cached;
  }
  const authorization = await buildAuthorization("get", {
    content: "Get media",
    targetUrl: url,
  });
  const headers: Record<string, string> = { Authorization: authorization };
  const authTag = getAuthTagJson();
  if (authTag) {
    headers["x-auth-tag"] = authTag;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Media fetch failed (${response.status})`);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  objectUrlCache.set(url, objectUrl);
  return objectUrl;
}
