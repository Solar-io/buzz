/**
 * Authoring the sender's side of a link preview.
 *
 * `linkPreview.ts` reads snapshot tags off a received event. This is the other
 * direction: turning the relay's unfurl answer into the tag that goes on the
 * outgoing message, and deciding which tags a given send is allowed to carry.
 *
 * Everything here is a mirror of the relay's ingest check
 * (`validate_link_preview_tags`, `crates/buzz-relay/src/handlers/ingest.rs`),
 * because a tag that fails it takes the whole message down with it — the
 * message is rejected, not the tag. Re-checking locally turns "the relay
 * refused your message" into "this link simply sends as a plain link".
 *
 * The rules, read off that function:
 *
 * - exactly 11 parts, `["link-preview", "snapshot", "1", …]`;
 * - part 3 is an https URL with no credentials and no fragment, unique across
 *   the message, and **present verbatim in the content**;
 * - parts 4/5/6 (title/site/description) are capped at 300/100/1000 BYTES and
 *   carry no control characters, except `\n` in the description;
 * - parts 7/8 and 9/10 are (url, sha256) pairs that are either both empty or
 *   both point at an image blob on this relay's own media origin;
 * - at most 8 snapshots per message;
 * - `["link-preview", "none"]` suppresses previews and may not be combined
 *   with any snapshot.
 */

/** Ingest's `MAX_SNAPSHOTS`. */
export const MAX_SNAPSHOTS = 8;
const MAX_TITLE_BYTES = 300;
const MAX_SITE_BYTES = 100;
const MAX_DESCRIPTION_BYTES = 1000;
const IMAGE_EXTS = ["jpg", "png", "gif", "webp"];

/** The relay's answer for one URL. */
export interface UnfurlResult {
  url: string;
  title: string;
  site: string;
  description: string;
  image?: { url: string; sha256: string };
  favicon?: { url: string; sha256: string };
}

/** The per-message suppression marker the reader half already honours. */
export const SUPPRESSION_TAG: readonly string[] = ["link-preview", "none"];

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Trim to a byte budget without splitting a character.
 *
 * The relay already clamps, so this is a belt: a future relay with a larger
 * budget must not be able to hand back a value that this client then sends
 * into a rejection.
 */
function clampBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  let out = value;
  while (out.length > 0 && byteLength(out) > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Control characters break ingest's text check. `\n` is legal in the
 * description only, so it is kept there and turned into a space elsewhere —
 * dropping it outright would weld two words together.
 */
function scrubText(value: string, allowNewlines: boolean): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      out += character;
    } else if (allowNewlines && character === "\n") {
      out += character;
    } else {
      out += " ";
    }
  }
  return out;
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * A media pair is valid when it is empty, or when it names an image blob on
 * `mediaOrigin` whose filename is exactly `<sha256>.<image ext>`.
 *
 * `mediaOrigin` is the relay's own origin. Anything else is a third-party
 * asset, which is the one thing this feature exists to avoid: a reader who
 * renders it would announce themselves to that host.
 */
export function isValidMediaPair(
  url: string,
  sha256: string,
  mediaOrigin: string,
): boolean {
  if (url === "" && sha256 === "") {
    return true;
  }
  if (url === "" || !isSha256(sha256)) {
    return false;
  }
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(mediaOrigin);
  } catch {
    return false;
  }
  if (
    parsed.origin !== origin.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return false;
  }
  const filename = parsed.pathname.startsWith("/media/")
    ? parsed.pathname.slice("/media/".length)
    : null;
  if (filename === null || filename.includes("/") || filename.includes("%")) {
    return false;
  }
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  return (
    filename.slice(0, dot) === sha256 &&
    IMAGE_EXTS.includes(filename.slice(dot + 1))
  );
}

/** The canonical URL rules ingest applies to part 3. */
export function isValidCanonicalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hash === ""
  );
}

/**
 * Build one snapshot tag, or `null` when the result cannot make a legal one.
 *
 * `null` is not an error path worth surfacing: the message still sends, with a
 * plain link, which is exactly what a client without this feature does.
 */
export function buildSnapshotTag(
  result: UnfurlResult,
  mediaOrigin: string,
): string[] | null {
  if (!isValidCanonicalUrl(result.url)) {
    return null;
  }
  const title = clampBytes(
    scrubText(result.title, false),
    MAX_TITLE_BYTES,
  ).trim();
  if (title === "") {
    return null;
  }
  const site = clampBytes(scrubText(result.site, false), MAX_SITE_BYTES).trim();
  const description = clampBytes(
    scrubText(result.description, true),
    MAX_DESCRIPTION_BYTES,
  ).trim();

  // An asset that fails the origin check is dropped, not carried: a card with
  // no image is fine, a message the relay refuses is not.
  const image =
    result.image &&
    isValidMediaPair(result.image.url, result.image.sha256, mediaOrigin)
      ? result.image
      : { url: "", sha256: "" };
  const favicon =
    result.favicon &&
    isValidMediaPair(result.favicon.url, result.favicon.sha256, mediaOrigin)
      ? result.favicon
      : { url: "", sha256: "" };

  return [
    "link-preview",
    "snapshot",
    "1",
    result.url,
    title,
    site,
    description,
    image.url,
    image.sha256,
    favicon.url,
    favicon.sha256,
  ];
}

/**
 * The tags this send may carry.
 *
 * Keyed off the hrefs in the content being sent *right now*, never a debounced
 * or cached set: a tag prepared for a URL the author has since deleted must
 * not ride along on a message that no longer contains it. Ingest would reject
 * that message outright (the canonical URL must appear in the content), so
 * this is a correctness gate, not tidiness.
 *
 * Suppression wins outright and emits only the marker, which is what the
 * reader half already looks for.
 */
export function selectSnapshotTags(options: {
  content: string;
  liveHrefs: readonly string[];
  tagsByHref: ReadonlyMap<string, string[]>;
  suppressed: boolean;
}): string[][] {
  if (options.suppressed) {
    return [[...SUPPRESSION_TAG]];
  }
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const href of options.liveHrefs) {
    if (tags.length >= MAX_SNAPSHOTS) {
      break;
    }
    const tag = options.tagsByHref.get(href);
    if (!tag || seen.has(href)) {
      continue;
    }
    // The verbatim-presence rule. `liveHrefs` is derived from this content, so
    // this normally holds — but a caller could pass a stale list, and the cost
    // of being wrong is the whole message bouncing.
    if (!options.content.includes(href)) {
      continue;
    }
    seen.add(href);
    tags.push(tag);
  }
  return tags;
}
