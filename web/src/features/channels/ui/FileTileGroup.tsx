import { Folder } from "lucide-react";
import { sourcePath } from "@/features/shelf/lib/fileSource.ts";
import {
  commonFolder,
  distinguishingParts,
  folderCrumbs,
} from "@/features/shelf/lib/shareEvent.ts";
import { useTileOpener } from "@/features/shelf/useTileOpener.ts";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/ui/spinner";
import { formatFileSize, type FileCardTarget } from "../lib/messageMedia.ts";
import { useFileDownload } from "./FileCard.tsx";
import { useMessageMedia } from "./messageMediaContext.ts";

/**
 * "html", "pdf", "md" — the tile's thumbnail. A file with no extension (or an
 * implausibly long one) shows a neutral "FILE" rather than a guess.
 */
export function fileTypeLabel(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  return match ? match[1].toUpperCase() : "FILE";
}

function Tile({
  file,
  thumb,
}: {
  file: FileCardTarget;
  /** What tells this file from its siblings ("C"), else its type. */
  thumb: string;
}) {
  const { downloading, download } = useFileDownload(file.href, file.filename);
  const tile = useTileOpener(file);
  const detail = tile.selected
    ? "open in pane →"
    : file.size !== undefined
      ? formatFileSize(file.size)
      : null;
  return (
    <button
      type="button"
      data-testid="file-tile"
      data-selected={tile.selected ? "true" : undefined}
      disabled={downloading}
      aria-label={
        tile.open ? `Open ${file.filename}` : `Download ${file.filename}`
      }
      onClick={tile.open ?? download}
      className={cn(
        "relative flex min-w-0 flex-col gap-1.5 border-t border-l border-border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-70",
        tile.selected && "bg-sunk",
      )}
    >
      <span
        className={cn(
          "grid h-13.5 place-items-center rounded-lg bg-chip font-mono font-bold tracking-wide text-muted-foreground",
          thumb.length <= 3 ? "text-xl" : "text-sm",
          tile.selected && "ring-1 ring-ink-2",
        )}
      >
        {downloading ? <Spinner className="size-4" /> : thumb}
      </span>
      <span className="truncate font-mono text-xs font-semibold text-foreground">
        {file.filename}
      </span>
      {detail ? (
        <span className="font-mono text-2xs text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Several file attachments in one message, as one surface (Message
 * artboard's file group): a quiet header — the folder they came from when a
 * `buzz share` recorded one, else how many — and a grid of tiles, each of
 * which opens its file in a tab beside the chat (Phase 6; it downloads
 * outside the shell). A share's header also links to the Shelf.
 *
 * Tiles named in a series (`game-A.html … game-D.html`) show the letter that
 * tells them apart, the way the artboard does; otherwise the type.
 *
 * Every tile draws its own top and left hairline and the grid is pulled one
 * pixel up and left under the card's clip, so the lines stay right at every
 * column count and an incomplete last row shows plain card, not a grey cell.
 */
export function FileTileGroup({ files }: { files: readonly FileCardTarget[] }) {
  const { fileSource } = useMessageMedia();
  const opener = useTileOpener(files[0] ?? { href: "", filename: "" });
  const folder = commonFolder(
    files.map((file) => sourcePath(fileSource ?? null, file.href)),
  );
  const crumbs = folder ? folderCrumbs(folder.path) : [];
  const parts = distinguishingParts(files.map((file) => file.filename));
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
        {crumbs.length > 0 ? (
          // The folder the files are IN never truncates; the path above it
          // gives way first in a narrow column.
          <span
            data-testid="file-tile-group-folder"
            className="flex min-w-0 items-baseline font-mono text-xs whitespace-pre text-ink-2"
            title={folder ? `${folder.host}:${folder.path}` : undefined}
          >
            {crumbs.length > 1 ? (
              <>
                <span className="min-w-0 truncate">
                  {crumbs.slice(0, -1).join(" / ")}
                </span>
                <span className="shrink-0"> / </span>
              </>
            ) : null}
            <b className="shrink-0 font-semibold text-foreground">
              {crumbs[crumbs.length - 1]}
            </b>
          </span>
        ) : (
          <span
            data-testid="file-tile-group-folder"
            className="font-mono text-xs text-ink-2"
          >
            <b className="font-semibold text-foreground">{files.length}</b>{" "}
            files
          </span>
        )}
        {opener.onShelf && opener.openShelf ? (
          <button
            type="button"
            onClick={opener.openShelf}
            className="ml-auto shrink-0 text-xs font-semibold whitespace-nowrap text-info-ink hover:underline"
          >
            Open in Shelf →
          </button>
        ) : null}
      </div>
      <div className="-ml-px grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]">
        {files.map((file, index) => (
          <Tile
            key={file.href}
            file={file}
            thumb={parts?.[index] ?? fileTypeLabel(file.filename)}
          />
        ))}
      </div>
    </div>
  );
}
