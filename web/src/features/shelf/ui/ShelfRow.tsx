import { ChevronRight } from "lucide-react";

import { formatFileSize } from "@/features/channels/lib/messageMedia.ts";
import { cn } from "@/shared/lib/cn";
import { HexAvatar, HumanAvatar } from "@/shared/ui/HexAvatar";
import { kindLabel } from "../lib/fileKind.ts";
import {
  commonFolder,
  compressedNames,
  folderCrumbs,
  type Share,
  type ShareFile,
} from "../lib/shareEvent.ts";
import type { ShelfRow as Row } from "../lib/shelfView.ts";
import { FileIcon } from "./FileIcon";

export type ShelfLayout = "wide" | "medium" | "narrow";

/** File | From | Shared in | When — the Shelf artboard's columns. */
export const SHELF_COLUMNS: Record<Exclude<ShelfLayout, "narrow">, string> = {
  wide: "grid-cols-[minmax(0,1fr)_8rem_8.5rem_4.25rem]",
  medium: "grid-cols-[minmax(0,1fr)_7.5rem_4.25rem]",
};

export interface ShelfRowNames {
  person: (pubkey: string) => string;
  channel: (id: string) => string;
  isAgent: (pubkey: string) => boolean;
}

function Sender({ pubkey, names }: { pubkey: string; names: ShelfRowNames }) {
  const label = names.person(pubkey);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {names.isAgent(pubkey) ? (
        <HexAvatar label={label} seed={pubkey} size={14} ring="card" />
      ) : (
        <HumanAvatar label={label} size={16} />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** The bold line: the file's name, or a multi-file share's folder and set. */
function rowTitle(files: readonly ShareFile[]): string {
  if (files.length === 1) {
    return files[0].filename;
  }
  const names = compressedNames(files.map((file) => file.filename));
  const folder = commonFolder(files.map((file) => file.path));
  const crumb = folder ? folderCrumbs(folder.path).pop() : null;
  return crumb ? `${crumb} / ${names}` : names;
}

/** The muted line: the share's own words, or what the file is. */
function rowSummary(share: Share, files: readonly ShareFile[]): string {
  if (share.summary !== "") {
    return share.summary;
  }
  if (files.length > 1) {
    return `${files.length} files`;
  }
  const file = files[0];
  return [
    kindLabel(file.kind),
    file.size !== null ? formatFileSize(file.size) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One share on the Shelf. A single file opens on click; a share of several
 * files opens to list them (each opens on its own) — the artboard's
 * `rts-bakeoff / game-A…D.html` row.
 */
export function ShelfRow({
  row,
  layout,
  names,
  when,
  selectedKey,
  expanded,
  onToggle,
  onOpen,
}: {
  row: Row;
  layout: ShelfLayout;
  names: ShelfRowNames;
  when: string;
  /** The open file tab's key, to mark its row. */
  selectedKey: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (file: ShareFile) => void;
}) {
  const { share, files } = row;
  const multi = files.length > 1;
  const title = rowTitle(files);
  const selected = selectedKey?.startsWith(`${share.id}|`) === true;
  const icon = (
    <FileIcon kind={files[0].kind} size={layout === "narrow" ? "lg" : "md"} />
  );
  const activate = () => (multi ? onToggle() : onOpen(files[0]));
  const where = names.channel(share.channelId);

  return (
    <div
      data-testid="shelf-row"
      data-share={share.id}
      className={cn(
        "border-b border-border",
        selected &&
          "-mx-2.5 rounded-[9px] border-transparent bg-sunk px-2.5 ring-1 ring-border",
      )}
    >
      <button
        type="button"
        aria-expanded={multi ? expanded : undefined}
        aria-label={multi ? `${title}, ${files.length} files` : `Open ${title}`}
        onClick={activate}
        className={cn(
          "w-full text-left text-sm transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          layout === "narrow"
            ? "flex items-start gap-3 py-3"
            : cn("grid min-h-12.5 items-center py-1.5", SHELF_COLUMNS[layout]),
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          {icon}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1">
              <span
                data-testid="shelf-row-title"
                className="truncate font-mono text-xs font-semibold"
              >
                {title}
              </span>
              {multi ? (
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground transition-transform",
                    expanded && "rotate-90",
                  )}
                />
              ) : null}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {rowSummary(share, files)}
            </span>
            {layout !== "wide" ? (
              <span className="mt-0.5 block truncate font-mono text-2xs text-muted-foreground">
                {layout === "narrow"
                  ? `${names.person(share.authorPubkey)} · ${where}`
                  : where}
              </span>
            ) : null}
          </span>
        </span>
        {layout === "narrow" ? (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">
            {when}
          </span>
        ) : (
          <>
            <span className="min-w-0 pr-2 text-xs">
              <Sender pubkey={share.authorPubkey} names={names} />
            </span>
            {layout === "wide" ? (
              <span className="truncate pr-2 font-mono text-xs text-ink-2">
                {where}
              </span>
            ) : null}
            <span className="text-right font-mono text-2xs text-muted-foreground">
              {when}
            </span>
          </>
        )}
      </button>
      {multi && expanded ? (
        <ul
          data-testid="shelf-row-files"
          className={cn("pb-2", layout === "narrow" ? "pl-10" : "pl-9.5")}
        >
          {files.map((file) => (
            <li key={file.url}>
              <button
                type="button"
                onClick={() => onOpen(file)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <FileIcon kind={file.kind} size="sm" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {file.filename}
                </span>
                {file.size !== null ? (
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
