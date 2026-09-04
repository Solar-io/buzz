/**
 * Reading the relay's link-preview capability out of its NIP-11 document.
 *
 * Pure — no fetch, no aliases — so it can be unit-tested directly. The
 * transport half lives in `relayLinkPreview.ts`.
 *
 * `crates/buzz-relay/src/nip11.rs` advertises `link_preview: { unfurl }` and
 * the `buzz-link-preview` extension on any relay that can unfurl. Absent means
 * an older or upstream relay, and the composer must stay silent rather than
 * offering a feature that will 404.
 */

/** NIP-11 shape, narrowed to what this feature reads. */
export interface RelayInfo {
  link_preview?: { unfurl?: unknown };
  supported_extensions?: unknown;
}

export interface LinkPreviewCapability {
  /** Relay-relative unfurl path, e.g. `/link-preview/unfurl`. */
  unfurlPath: string;
  /** Origin that snapshot media must live on — this relay's own. */
  mediaOrigin: string;
}

/** Read the unfurl capability out of a NIP-11 document, or null. */
export function linkPreviewCapability(
  info: RelayInfo | null | undefined,
  baseUrl: string,
): LinkPreviewCapability | null {
  const path = info?.link_preview?.unfurl;
  if (typeof path !== "string" || !path.startsWith("/")) {
    return null;
  }
  const extensions = info?.supported_extensions;
  if (Array.isArray(extensions) && !extensions.includes("buzz-link-preview")) {
    return null;
  }
  let mediaOrigin: string;
  try {
    mediaOrigin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  return { unfurlPath: path, mediaOrigin };
}
