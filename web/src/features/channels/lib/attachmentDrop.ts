/**
 * Drag-and-drop entry point for composer attachments.
 *
 * The tray, the upload queue and the accept rules are the picker's — a drop
 * is only another way IN, so this module does exactly two things: decide what
 * a drag is carrying, and split a dropped file list into attach vs. reject
 * using the SAME rules the picker enforces (`attachmentRejectionReason`).
 * Whatever lands in `accepted` flows into the composer's ordinary
 * `attachFiles` path; `rejections` are surfaced as toasts, also like the
 * picker's.
 */

import { attachmentRejectionReason } from "./attachmentAccept.ts";

/** A dropped file the queue will NOT take, and the words shown for it. */
export interface DropRejection {
  name: string;
  reason: string;
}

/** Accepted keeps the drop's list order — the tray rows follow the drop. */
export interface DropPartition {
  accepted: File[];
  rejections: DropRejection[];
}

export const FOLDER_REJECTION_REASON =
  "Folders can't be attached — drop the files inside instead.";

/**
 * Is this drag carrying files at all?
 *
 * `dataTransfer.types` is the only dragover-safe signal: the data itself is
 * read-protected until drop, but the type list is not. A text/URL drag has no
 * "Files" entry, so the composer neither shows the drop overlay nor handles
 * the drop — the browser keeps its text-drag default.
 */
export function dragCarriesFiles(
  dataTransfer: { types: readonly string[] } | null,
): boolean {
  return dataTransfer?.types.includes("Files") ?? false;
}

/**
 * Partition a dropped file list into queueable files and rejects, in order.
 *
 * Folder entries: the DataTransfer hands directories over as `File`-shaped
 * entries too (typeless, zero-byte). A bare `File` cannot be proven to be a
 * directory — the reliable signal (`webkitGetAsEntry().isDirectory`) lives on
 * the DataTransferItem, outside this function's file-list input — so this is
 * the honest heuristic: no MIME, no bytes, no extension. Empty extensionless
 * files like `.gitkeep` still pass (they carry a dot); a folder literally
 * named "like.a.file" would slip through to an upload attempt the relay
 * rejects. Documented v1 limitation; no recursion either way.
 */
export function partitionDropFiles(files: readonly File[]): DropPartition {
  const accepted: File[] = [];
  const rejections: DropRejection[] = [];
  for (const file of files) {
    const looksLikeFolder =
      file.type === "" && file.size === 0 && !file.name.includes(".");
    if (looksLikeFolder) {
      rejections.push({ name: file.name, reason: FOLDER_REJECTION_REASON });
      continue;
    }
    const reason = attachmentRejectionReason(file);
    if (reason) {
      rejections.push({ name: file.name, reason });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejections };
}
