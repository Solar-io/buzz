import { Folder } from "lucide-react";
import { Spinner } from "@/shared/ui/spinner";
import { formatFileSize, type FileCardTarget } from "../lib/messageMedia.ts";
import { useFileDownload } from "./FileCard.tsx";

/**
 * "html", "pdf", "md" — the tile's thumbnail. A file with no extension (or an
 * implausibly long one) shows a neutral "FILE" rather than a guess.
 */
export function fileTypeLabel(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  return match ? match[1].toUpperCase() : "FILE";
}

function Tile({ file }: { file: FileCardTarget }) {
  const { downloading, download } = useFileDownload(file.href, file.filename);
  return (
    <button
      type="button"
      data-testid="file-tile"
      disabled={downloading}
      aria-label={`Download ${file.filename}`}
      onClick={download}
      className="flex min-w-0 flex-col gap-1.5 border-t border-l border-border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-70"
    >
      <span className="grid h-13.5 place-items-center rounded-lg bg-chip font-mono text-sm font-bold tracking-wide text-muted-foreground">
        {downloading ? (
          <Spinner className="size-4" />
        ) : (
          fileTypeLabel(file.filename)
        )}
      </span>
      <span className="truncate font-mono text-xs font-semibold text-foreground">
        {file.filename}
      </span>
      {file.size !== undefined ? (
        <span className="font-mono text-2xs text-muted-foreground">
          {formatFileSize(file.size)}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Several file attachments in one message, as one surface (web redesign
 * Phase 2; Message artboard's file group): a quiet header that says how many,
 * and a grid of tiles — type, name, size — each of which downloads its file.
 *
 * A message that shares four deliverables used to stack four full-width
 * download cards; as tiles they read as one set and take a third of the
 * height. The header's path and "Open in Shelf" arrive with Phase 6, when a
 * share carries them — until then it states only what the message knows.
 *
 * Every tile draws its own top and left hairline and the grid is pulled one
 * pixel up and left under the card's clip, so the lines stay right at every
 * column count and an incomplete last row shows plain card, not a grey cell.
 */
export function FileTileGroup({ files }: { files: readonly FileCardTarget[] }) {
  return (
    <div
      data-testid="file-tile-group"
      className="my-2 max-w-2xl overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex h-9.5 items-center gap-2 bg-sunk px-3">
        <Folder
          aria-hidden
          className="size-3.75 shrink-0 text-muted-foreground"
        />
        <span className="font-mono text-xs text-ink-2">
          <b className="font-semibold text-foreground">{files.length}</b> files
        </span>
      </div>
      <div className="-ml-px grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]">
        {files.map((file) => (
          <Tile key={file.href} file={file} />
        ))}
      </div>
    </div>
  );
}
