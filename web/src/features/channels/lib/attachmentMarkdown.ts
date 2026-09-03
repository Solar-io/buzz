/**
 * Markdown the composer appends for an uploaded attachment, and the inverse
 * used by the tray's remove control.
 *
 * `imeta.ts` already builds the image/video form (`![image](url)`), which the
 * renderer turns into a signed-fetch `<img>`/`<video>`. Now that the relay's
 * generic attachment path is reachable from the web picker, there is a third
 * shape: a plain link carrying the file's own name, which `MessageLink` opens
 * through `openLink`'s signed popup viewer.
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
