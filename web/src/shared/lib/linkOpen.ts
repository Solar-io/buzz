/**
 * Link-click disposition for message content: a clicked link must NEVER
 * navigate the SPA tab away. File-typical URLs open as a popup viewer
 * window; everything else opens as a new tab.
 *
 * Relay media URLs (/media/…) are auth-gated, so they are fetched with a
 * signed GET and the popup navigates to the blob URL instead (a plain
 * window would receive the relay's 401 JSON). The popup is opened
 * synchronously inside the click gesture — opening AFTER an await trips
 * popup blockers — and its location is set once the blob resolves.
 */

export type LinkDisposition = "popup" | "tab" | "default";

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
 * file extension open as a popup; other http(s) URLs open as a tab;
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
    return "popup";
  }
  return "tab";
}

/**
 * True when the URL points at the relay's Blossom media store (auth-gated,
 * needs a signed GET before a window can show it).
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

const POPUP_FEATURES = "popup=yes,width=960,height=720";
const POPUP_FEATURES_NOOPENER = `${POPUP_FEATURES},noopener,noreferrer`;

/**
 * Open a classified link. `fetchSigned` is injectable for tests; the
 * default is wired at the call site (shared/api/blossom) to avoid a
 * dependency cycle.
 *
 * Popup mechanics, carefully: `noopener` makes window.open return null, so
 * plain file URLs navigate AT creation (secure, no handle needed). Relay
 * media must be signed-fetched first, which needs a live handle — that
 * popup opens WITHOUT noopener and is navigated to an inert blob: URL
 * (images/media carry no script, so the kept opener link is not a
 * tabnabbing surface; it mirrors what the inline <img> path already does).
 */
export async function openLink(
  href: string,
  options: {
    relayBase: string;
    fetchSigned?: (url: string) => Promise<string>;
    onError?: (message: string) => void;
  },
): Promise<LinkDisposition> {
  const disposition = linkDisposition(href);
  if (disposition === "default") {
    return disposition;
  }
  const resolved = new URL(href, window.location.origin).href;

  if (disposition === "tab") {
    window.open(resolved, "_blank", "noopener,noreferrer");
    return disposition;
  }

  if (!isRelayMediaHref(resolved, options.relayBase) || !options.fetchSigned) {
    window.open(resolved, "buzz-file-viewer", POPUP_FEATURES_NOOPENER);
    return disposition;
  }

  // Relay media: open inside the gesture (a window.open after an await
  // trips popup blockers), then navigate to the signed blob.
  const viewer = window.open("", "buzz-file-viewer", POPUP_FEATURES);
  if (!viewer) {
    options.onError?.("Allow popups for Buzz to view files inline.");
    return disposition;
  }
  try {
    const objectUrl = await options.fetchSigned(resolved);
    viewer.location.href = objectUrl;
  } catch {
    viewer.close();
    options.onError?.(
      "Could not load that file from the relay store (auth failed).",
    );
  }
  return disposition;
}
