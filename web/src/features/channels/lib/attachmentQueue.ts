/**
 * The composer's attachment queue.
 *
 * Before this the composer had two booleans — `uploading` and a
 * `BlobDescriptor[]` — so a multi-file upload showed one pulsing paperclip,
 * a failure mid-batch left the earlier files attached with no way to see
 * which had landed, and there was no way to remove one. The queue keeps a row
 * per file with its own status and progress, which is what the tray renders.
 *
 * Pure transitions, so the state machine is testable without a relay: every
 * function returns a NEW array and never mutates its input.
 */

import type { BlobDescriptor } from "@/shared/api/blossom";

export type AttachmentStatus = "queued" | "uploading" | "done" | "error";

export interface QueuedAttachment {
  /** Stable local id — the queue's identity, independent of the blob hash. */
  id: string;
  name: string;
  size: number;
  mime: string;
  status: AttachmentStatus;
  /** 0..1, only meaningful while `status` is "uploading" or "done". */
  progress: number;
  /** Why it failed, when `status` is "error". */
  error?: string;
  /** The relay's descriptor, once the upload has landed. */
  descriptor?: BlobDescriptor;
  /** Object URL for a local image preview; revoked on removal. */
  previewUrl?: string;
}

let nextId = 0;

/** Monotonic local id. Not a hash: two identical files are two queue rows. */
export function nextAttachmentId(): string {
  nextId += 1;
  return `att-${nextId}`;
}

/** A fresh queued row for a picked file. */
export function queuedFrom(
  file: { name: string; size: number; type: string },
  previewUrl?: string,
): QueuedAttachment {
  return {
    id: nextAttachmentId(),
    name: file.name || "attachment",
    size: file.size,
    mime: file.type || "application/octet-stream",
    status: "queued",
    progress: 0,
    previewUrl,
  };
}

function patch(
  queue: readonly QueuedAttachment[],
  id: string,
  changes: Partial<QueuedAttachment>,
): QueuedAttachment[] {
  return queue.map((item) => (item.id === id ? { ...item, ...changes } : item));
}

export function markUploading(
  queue: readonly QueuedAttachment[],
  id: string,
): QueuedAttachment[] {
  return patch(queue, id, {
    status: "uploading",
    progress: 0,
    error: undefined,
  });
}

export function withProgress(
  queue: readonly QueuedAttachment[],
  id: string,
  fraction: number,
): QueuedAttachment[] {
  const clamped = Math.max(0, Math.min(1, fraction));
  return patch(queue, id, { progress: clamped });
}

export function markUploaded(
  queue: readonly QueuedAttachment[],
  id: string,
  descriptor: BlobDescriptor,
): QueuedAttachment[] {
  return patch(queue, id, {
    status: "done",
    progress: 1,
    descriptor,
    error: undefined,
  });
}

export function markFailed(
  queue: readonly QueuedAttachment[],
  id: string,
  error: string,
): QueuedAttachment[] {
  return patch(queue, id, { status: "error", error });
}

export function removeAttachment(
  queue: readonly QueuedAttachment[],
  id: string,
): QueuedAttachment[] {
  return queue.filter((item) => item.id !== id);
}

/** Descriptors for the imeta tags — only files that actually uploaded. */
export function uploadedDescriptors(
  queue: readonly QueuedAttachment[],
): BlobDescriptor[] {
  return queue
    .filter((item) => item.status === "done" && item.descriptor)
    .map((item) => item.descriptor as BlobDescriptor);
}

/** True while any row is still in flight — the send button waits on this. */
export function hasPendingUploads(queue: readonly QueuedAttachment[]): boolean {
  return queue.some(
    (item) => item.status === "queued" || item.status === "uploading",
  );
}

/**
 * Rebuild queue rows from a restored draft. Everything stored is by
 * definition already uploaded — bytes still in flight cannot be persisted, and
 * a `File` cannot be revived from localStorage — so each row comes back "done".
 */
export function queueFromDescriptors(
  descriptors: readonly BlobDescriptor[],
  filenames: { [url: string]: string } = {},
): QueuedAttachment[] {
  return descriptors.map((descriptor) => ({
    id: nextAttachmentId(),
    name: filenames[descriptor.url] ?? fallbackName(descriptor),
    size: descriptor.size,
    mime: descriptor.mime_type,
    status: "done" as const,
    progress: 1,
    descriptor,
  }));
}

/** Last path segment of the blob url — "<sha>.png" — when no name is stored. */
function fallbackName(descriptor: BlobDescriptor): string {
  const segment = descriptor.url.split("/").pop() ?? "";
  return segment || "attachment";
}

/** url → original filename, for persisting alongside the descriptors. */
export function filenamesByUrl(queue: readonly QueuedAttachment[]): {
  [url: string]: string;
} {
  const out: { [url: string]: string } = {};
  for (const item of queue) {
    if (item.descriptor) {
      out[item.descriptor.url] = item.name;
    }
  }
  return out;
}
