/**
 * Link-click disposition for message content: a clicked link must NEVER
 * navigate the SPA tab away. File-typical URLs render in the in-app
 * FileViewerDialog overlay (the caller routes them to `useFileViewer`);
 * genuinely external http(s) targets open as one deliberate `_blank` tab;
 * non-http schemes use browser default. A link click never creates any
 * other window — the old popup-viewer path is gone (a `window.open` after
 * any await trips popup blockers, and the OS window chrome it needed is
 * exactly what the installed-app URL bar complaint was about).
 */

import { publicAppOrigin } from "./relay-url.ts";

export type LinkDisposition = "overlay" | "tab" | "default";

const FILE_EXTENSIONS = new Set([
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "ico",
  // video / audio
  "mp4",
  "webm",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  // documents / text
  "pdf",
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "html",
  "htm",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pages",
  "numbers",
  "key",
  "rtf",
  // archives / code
  "zip",
  "tar",
  "gz",
  "bz2",
  "7z",
  "rar",
  "dmg",
  "iso",
  "ts",
  "js",
  "py",
  "sh",
  "rs",
  "toml",
]);

/** Parse-relative base so pure classification stays testable. */
const TEST_BASE = "https://buzz.invalid";

/**
 * Classify a link. http(s) (or relative) URLs whose path ends in a known
 * file extension are overlay material; other http(s) URLs open as a tab;
 * anything else (mailto:, javascript:, unparsable) uses browser default.
 */
export function linkDisposition(href: string): LinkDisposition {
  if (href.trim() === "") {
    return "default";
  }
  let url: URL;
  try {
    url = new URL(href, TEST_BASE);
  } catch {
    return "default";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "default";
  }
  const segment = url.pathname.split("/").pop() ?? "";
  const match = /\.([a-z0-9]{1,8})$/i.exec(segment);
  if (match && FILE_EXTENSIONS.has(match[1].toLowerCase())) {
    return "overlay";
  }
  return "tab";
}

/**
 * How the FileViewerDialog renders a file-typical URL. Extension-driven:
 * the dialog only needs to pick a tag — `<img>`/`<video>`/`<audio>` read
 * the real MIME off the (possibly signed) blob themselves.
 */
export type FileViewerKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "text"
  | "html"
  | "fallback";

const VIEWER_KIND_BY_EXTENSION: Record<string, FileViewerKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  avi: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  pdf: "pdf",
  md: "markdown",
  txt: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  ts: "text",
  js: "text",
  py: "text",
  sh: "text",
  rs: "text",
  toml: "text",
  html: "html",
  htm: "html",
};

/**
 * Pick the viewer rendering for a URL. Everything not in the map — office
 * documents, archives, unknown extensions — is "fallback" (icon + name +
 * download). Text/code extensions are joined with the "text" kind.
 */
export function fileViewerKind(href: string): FileViewerKind {
  let url: URL;
  try {
    url = new URL(href, TEST_BASE);
  } catch {
    return "fallback";
  }
  const segment = url.pathname.split("/").pop() ?? "";
  const match = /\.([a-z0-9]{1,8})$/i.exec(segment);
  const kind = match
    ? VIEWER_KIND_BY_EXTENSION[match[1].toLowerCase()]
    : undefined;
  return kind ?? "fallback";
}

/**
 * True when the URL points at the relay's Blossom media store (auth-gated,
 * needs a signed GET before anything can show it).
 */
export function isRelayMediaHref(href: string, relayBase: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href, TEST_BASE);
    base = new URL(relayBase);
  } catch {
    return false;
  }
  return url.host === base.host && url.pathname.startsWith("/media/");
}

/**
 * True when the URL is a Daily Edition page served by the relay's own docs
 * proxy (relay origin + /edition/ path). Those pages are OURS — their inline
 * tab script is trusted enough to run in the viewer, in an opaque origin
 * (sandbox="allow-scripts" WITHOUT allow-same-origin, so the page can toggle
 * its tabs but reaches none of the SPA's origin state). Strangers' .html
 * stays scriptless.
 */
export function isRelayEditionHref(href: string, relayBase: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href, TEST_BASE);
    base = new URL(relayBase);
  } catch {
    return false;
  }
  return url.host === base.host && url.pathname.startsWith("/edition/");
}

/**
 * Open a classified link as a `_blank` tab. Only "tab" and "default"
 * dispositions belong here — "overlay" links go to the FileViewerDialog
 * via `useFileViewer` at the call site, which owns the signed-fetch and
 * error surfacing this function used to carry.
 */
export function openLink(href: string): LinkDisposition {
  const disposition = linkDisposition(href);
  if (disposition === "default") {
    return disposition;
  }
  if (disposition === "overlay") {
    // Defensive: a caller routed an overlay link here. Do NOT open a window
    // with it — the in-app viewer is the only sanctioned renderer.
    return disposition;
  }
  const resolved = new URL(href, publicAppOrigin()).href;
  window.open(resolved, "_blank", "noopener,noreferrer");
  return disposition;
}
