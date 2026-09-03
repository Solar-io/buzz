/**
 * Sender-authored link previews.
 *
 * These are NOT a recipient-side unfurl. The sender resolves the page and
 * writes the result into the event as tags, so a reader renders a preview
 * without ever contacting the third-party site — which is the whole point:
 * opening a channel must not fan out HTTP requests to every domain anyone has
 * ever linked, leaking the reader's IP and reading habits to each of them.
 *
 * The relay validates the shape on ingest
 * (`crates/buzz-relay/src/handlers/ingest.rs`), so anything reaching a client
 * has already been checked: exactly 11 parts, an https canonical URL that
 * actually appears in the message content, and image/favicon pairs that
 * reference blobs in this relay's own media store.
 *
 * The web client can therefore *render* previews with no relay change at all.
 * It cannot *author* them: that needs a cross-origin page fetch a browser
 * cannot read, plus re-uploading the images to Blossom. See
 * `web/docs/COMPATIBILITY.md`.
 */

/** Tag shape: ["link-preview","snapshot","1",url,title,site,desc,img,imgSha,icon,iconSha]. */
const SNAPSHOT_PARTS = 11;

export interface LinkPreview {
  /** Canonical https URL; the relay guarantees it appears in the content. */
  url: string;
  title: string;
  /** Site name, e.g. "GitHub". May be empty. */
  site: string;
  description: string;
  /** Preview image, hosted on this relay. Empty when the page had none. */
  imageUrl: string;
  /** Favicon, hosted on this relay. Empty when the page had none. */
  faviconUrl: string;
}

export interface LinkPreviewSet {
  previews: LinkPreview[];
  /**
   * The sender explicitly suppressed previews for this message
   * (`["link-preview","none"]`). Distinct from "no previews present": a
   * suppressed message must not later grow one, and the marker is the record
   * of that intent.
   */
  suppressed: boolean;
}

const EMPTY: LinkPreviewSet = { previews: [], suppressed: false };

/**
 * Read link-preview tags off an event.
 *
 * Defensive despite the relay's validation: a client may be talking to an
 * older relay, or one running a fork without the check, and a malformed tag
 * should drop that preview rather than throw inside a render.
 */
export function linkPreviewsFromTags(
  tags: readonly (readonly string[])[],
): LinkPreviewSet {
  let suppressed = false;
  const previews: LinkPreview[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    if (tag[0] !== "link-preview") continue;

    if (tag[1] === "none") {
      suppressed = true;
      continue;
    }
    if (
      tag.length !== SNAPSHOT_PARTS ||
      tag[1] !== "snapshot" ||
      tag[2] !== "1"
    ) {
      continue;
    }
    const url = tag[3];
    // https only, and one card per URL — the same guarantees the relay
    // enforces, re-checked because this may not be that relay.
    if (!url.startsWith("https://") || seen.has(url)) continue;
    seen.add(url);
    previews.push({
      url,
      title: tag[4] ?? "",
      site: tag[5] ?? "",
      description: tag[6] ?? "",
      imageUrl: tag[7] ?? "",
      faviconUrl: tag[9] ?? "",
    });
  }

  // Suppression wins outright. The relay rejects a message carrying both, but
  // a fork might not, and "the sender said no previews" is the safer reading.
  if (suppressed) {
    return { previews: [], suppressed: true };
  }
  return previews.length === 0 ? EMPTY : { previews, suppressed: false };
}
