import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";
import { kindLabel } from "@/features/shelf/lib/fileKind.ts";
import { FileIcon } from "@/features/shelf/ui/FileIcon";
import { useTileOpener } from "@/features/shelf/useTileOpener.ts";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/ui/spinner";
import { formatFileSize } from "../lib/messageMedia.ts";

/**
 * Download one relay attachment.
 *
 * Relay media is auth-gated, so a plain `<a href download>` would navigate to
 * the relay's 401 JSON. The bytes are fetched with a signed GET first and the
 * download is driven from the resulting object URL — the same trick the
 * inline `<img>` path already uses, since neither an anchor nor an image tag
 * can sign a request. Shared by the single card, the tile group and the file
 * pane's Download.
 */
export function useFileDownload(href: string, filename: string) {
  const [downloading, setDownloading] = useState(false);
  const download = () => {
    setDownloading(true);
    fetchSignedMedia(href)
      .then((objectUrl) => {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.rel = "noopener";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      })
      .catch(() => {
        toast.error(`Could not download ${filename}`);
      })
      .finally(() => setDownloading(false));
  };
  return { downloading, download };
}

/**
 * One generic (non-image, non-video) attachment. Inside the shell it is the
 * Preview artboard's file tile — a typed icon, the name, what it is, and
 * "Open", which opens it in a tab beside the chat (web redesign Phase 6).
 * Outside the shell (no file tabs) it stays the download card it was: the
 * web mirror of the desktop's `shared/ui/markdown/FileCard.tsx`. Several in
 * one message render as a `FileTileGroup` instead.
 */
export function FileCard({
  href,
  filename,
  size,
}: {
  href: string;
  filename: string;
  size?: number;
}) {
  const { downloading, download } = useFileDownload(href, filename);
  const tile = useTileOpener({ href, filename, size });
  const sizeLabel = size === undefined ? "" : formatFileSize(size);

  if (tile.open) {
    const meta = [
      kindLabel(tile.kind),
      sizeLabel || null,
      tile.onShelf ? "on the Shelf" : null,
    ].filter(Boolean);
    return (
      <button
        type="button"
        data-testid="file-card"
        data-selected={tile.selected ? "true" : undefined}
        aria-label={`Open ${filename}`}
        onClick={tile.open}
        className={cn(
          "my-1.5 flex w-full max-w-105 items-center gap-2.5 rounded-[10px] border bg-card px-3 py-2.5 text-left no-underline transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          tile.selected ? "border-ink-2 ring-3 ring-chip" : "border-border",
        )}
      >
        <FileIcon kind={tile.kind} size="lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs font-semibold text-foreground">
            {filename}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {meta.join(" · ")}
          </span>
        </span>
        <span className="shrink-0 text-xs font-semibold text-info-ink">
          {tile.selected ? "Open →" : "Open"}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="file-card"
      disabled={downloading}
      aria-label={`Download ${filename}`}
      className="my-1 inline-flex max-w-sm items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 text-left no-underline transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
      onClick={download}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-chip text-muted-foreground">
        {downloading ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <FileText className="h-4 w-4" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs font-semibold text-foreground">
          {filename}
        </span>
        {sizeLabel ? (
          <span className="block font-mono text-2xs text-muted-foreground">
            {sizeLabel}
          </span>
        ) : null}
      </span>
      <Download
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </button>
  );
}
