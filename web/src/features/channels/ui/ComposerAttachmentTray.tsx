import { File as FileIcon, Film, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import type { QueuedAttachment } from "../lib/attachmentQueue.ts";
import { formatAttachmentSize } from "../lib/attachmentMarkdown.ts";

function AttachmentGlyph({ mime }: { mime: string }) {
  if (mime.startsWith("image/")) {
    return <ImageIcon aria-hidden className="h-4 w-4" />;
  }
  if (mime.startsWith("video/")) {
    return <Film aria-hidden className="h-4 w-4" />;
  }
  return <FileIcon aria-hidden className="h-4 w-4" />;
}

function statusLine(item: QueuedAttachment): string {
  if (item.status === "error") {
    return item.error ?? "Upload failed";
  }
  if (item.status === "queued") {
    return "Waiting…";
  }
  if (item.status === "uploading") {
    return `${Math.round(item.progress * 100)}%`;
  }
  return formatAttachmentSize(item.size);
}

/**
 * Queued attachments above the composer input.
 *
 * Replaces the single `animate-pulse` paperclip, which said only "something
 * is happening" — not which file, how far along, whether one of a batch had
 * failed, or how to take one back out. Each row carries its own progress bar
 * and remove control, and a failed row stays visible with its reason rather
 * than disappearing into a toast.
 */
export function ComposerAttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: readonly QueuedAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul
      data-testid="composer-attachment-tray"
      aria-label="Queued attachments"
      className="mb-1.5 flex flex-wrap gap-1.5"
    >
      {attachments.map((item) => (
        <li
          key={item.id}
          data-testid="composer-attachment"
          data-status={item.status}
          className={cn(
            "relative flex min-w-0 max-w-56 items-center gap-2 overflow-hidden rounded-lg border bg-card px-2 py-1.5",
            item.status === "error" ? "border-destructive/60" : "border-border",
          )}
        >
          {item.previewUrl && item.mime.startsWith("image/") ? (
            <img
              src={item.previewUrl}
              alt=""
              className="h-8 w-8 shrink-0 rounded object-cover"
            />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
              <AttachmentGlyph mime={item.mime} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-foreground">
              {item.name}
            </span>
            <span
              className={cn(
                "block truncate text-2xs",
                item.status === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {statusLine(item)}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            title="Remove attachment"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onRemove(item.id)}
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
          {item.status === "uploading" || item.status === "queued" ? (
            // Determinate bar driven by real XHR upload progress — see
            // putWithProgress in shared/api/blossom.ts.
            <span
              className="absolute inset-x-0 bottom-0 h-0.5 bg-muted"
              role="progressbar"
              aria-label={`Uploading ${item.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(item.progress * 100)}
            >
              <span
                className="block h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(item.progress * 100)}%` }}
              />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
