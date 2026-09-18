/**
 * Markdown for an uploaded attachment, composed into the wire content at send
 * (Sam, 2026-09-17: the URL must not show in the composer's text box), and
 * the inverse used to migrate drafts saved with markdown baked into their
 * text.
 *
 * `imeta.ts` already builds the image/video form (`![image](url)`), which the
 * renderer turns into a signed-fetch `<img>`/`<video>`. Now that the relay's
 * generic attachment path is reachable from the web picker, there is a third
 * shape: a plain link carrying the file's own name, which `MessageLink` opens
 * in the in-app FileViewerDialog overlay (relay media is signed-fetched by
 * the viewer).
 */

import type { BlobDescriptor } from "@/shared/api/blossom";
import { mediaMarkdown } from "./imeta.ts";

/** Whether the descriptor renders inline (image/video) or as a file link. */
export function isInlineMedia(descriptor: BlobDescriptor): boolean {
  return (
    descriptor.mime_type.startsWith("image/") ||
    descriptor.mime_type.startsWith("video/")
  );
}

/**
 * Strip characters that would break out of a markdown link label. Brackets
 * are removed outright; whitespace (a newline in a filename is legal on
 * every POSIX filesystem) collapses to single spaces so the label stays on
 * one line.
 */
function safeLabel(name: string): string {
  const cleaned = name
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned === "" ? "attachment" : cleaned;
}

/**
 * The markdown snippet for one uploaded attachment, including its leading
 * newline (so appending to a non-empty composer never runs into the prose).
 */
export function attachmentMarkdown(
  descriptor: BlobDescriptor,
  filename?: string,
): string {
  if (isInlineMedia(descriptor)) {
    return mediaMarkdown(descriptor);
  }
  return `\n[${safeLabel(filename ?? "attachment")}](${descriptor.url})`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove every markdown reference to `url` from the composer text — image,
 * video or file link — along with the newline that introduced it.
 *
 * Removing the attachment without removing its markdown would leave a dead
 * link in the sent message; removing the markdown without matching the exact
 * URL would eat someone else's link. Both shapes are matched by URL, which is
 * unique per blob (it is the content hash).
 */
export function removeAttachmentMarkdown(text: string, url: string): string {
  const escaped = escapeForRegExp(url);
  const pattern = new RegExp(`\\n?!?\\[[^\\]\\n]*\\]\\(${escaped}\\)`, "g");
  return text.replace(pattern, "");
}

/**
 * The wire content for a send: the typed text with each queued attachment's
 * markdown appended, in queue order. The composer's text box never shows the
 * markdown (2026-09-17) — it exists only here, at send time, because the
 * renderer still resolves attachments from the content body.
 *
 * A descriptor whose link already appears in the text is skipped: drafts
 * saved before the hide-the-URL change carry their markdown in the stored
 * text, and re-appending would duplicate the link on the wire.
 */
export function composeSendContent(
  text: string,
  descriptors: readonly BlobDescriptor[],
  filenames: Readonly<{ [url: string]: string }> = {},
): string {
  let out = text.trim();
  for (const descriptor of descriptors) {
    if (out.includes(`](${descriptor.url})`)) {
      continue;
    }
    out += attachmentMarkdown(descriptor, filenames[descriptor.url]);
  }
  return out;
}

/**
 * Strip the markdown of exactly these descriptors from a draft's stored text
 * when it is restored — the migration half of the same old-draft case the
 * send-time dedupe above guards. URLs the author typed themselves (no
 * matching descriptor) are untouched.
 */
export function stripAttachmentsMarkdown(
  text: string,
  descriptors: readonly BlobDescriptor[],
): string {
  let out = text;
  for (const descriptor of descriptors) {
    out = removeAttachmentMarkdown(out, descriptor.url);
  }
  return out;
}

/** Human-readable size for the attachment tray. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
