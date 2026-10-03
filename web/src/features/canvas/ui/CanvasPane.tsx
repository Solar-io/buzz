import { FolderOpen, NotebookText, X } from "lucide-react";
import type { ReactNode } from "react";

import { fileKind } from "@/features/shelf/lib/fileKind.ts";
import {
  CHANNEL_CANVAS_KEY,
  type OpenFile,
} from "@/features/shelf/lib/fileTabs.ts";
import { FileIcon } from "@/features/shelf/ui/FileIcon";
import { FilePreview } from "@/features/shelf/ui/FilePreview";
import { cn } from "@/shared/lib/cn";
import type {
  ChannelCanvasDoc,
  ChannelCanvasPhase,
} from "../lib/channelCanvas.ts";
import { ChannelCanvasView } from "./ChannelCanvasView";

/** The pinned glyph for the channel canvas: a notebook on leaf. */
function ChannelCanvasIcon() {
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-leaf-soft text-leaf-ink"
    >
      <NotebookText className="size-3" />
    </span>
  );
}

function CanvasTab({
  label,
  title,
  icon,
  mono,
  selected,
  onSelect,
  onClose,
}: {
  label: string;
  title: string;
  icon: ReactNode;
  mono: boolean;
  selected: boolean;
  onSelect: () => void;
  /** Null: pinned (the channel canvas follows the conversation). */
  onClose: (() => void) | null;
}) {
  return (
    <div
      data-testid="canvas-tab"
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group/doc relative flex h-full max-w-56 shrink-0 items-center transition-colors",
        // The selected document is underlined into the page below it: a
        // second level, visibly unlike the pill-shaped Work | Canvas strip.
        "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full",
        selected
          ? "text-foreground after:bg-foreground"
          : "text-muted-foreground after:bg-transparent hover:text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={title}
        onClick={onSelect}
        className={cn(
          "flex h-full min-w-0 items-center gap-1.5 pl-1.5 text-xs font-medium",
          onClose ? "pr-1" : "pr-2.5",
          mono && "font-mono",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {onClose ? (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className={cn(
            "mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100",
            selected ? "opacity-100" : "opacity-0 group-hover/doc:opacity-100",
          )}
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function CanvasEmpty({ onOpenShelf }: { onOpenShelf: (() => void) | null }) {
  return (
    <div
      data-testid="canvas-empty"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background px-8 text-center"
    >
      <span
        aria-hidden
        className="grid size-10 place-items-center rounded-xl bg-chip text-ink-2"
      >
        <NotebookText className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">Nothing on the canvas</h2>
        <p className="max-w-72 text-xs leading-5 text-muted-foreground">
          Open a file from the chat or the Shelf and it lands here, next to
          Work. A channel&rsquo;s canvas is pinned first when it has one.
        </p>
      </div>
      {onOpenShelf ? (
        <button
          type="button"
          onClick={onOpenShelf}
          className="inline-flex h-7.5 items-center gap-1.5 rounded-lg border border-line-2 bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
        >
          <FolderOpen aria-hidden className="size-3.5" />
          Browse the Shelf
        </button>
      ) : null}
    </div>
  );
}

/**
 * The right pane's Canvas tab: its documents as sub-tabs — the channel
 * canvas pinned first, then the open files, each closable — over the
 * document on screen. Empty, it says what lands here and offers the Shelf.
 */
export function CanvasPane({
  items,
  selected,
  files,
  channelCanvas,
  expanded,
  onSelect,
  onClose,
  onOpenShelf,
}: {
  /** Document keys in sub-tab order (see canvasItemKeys). */
  items: readonly string[];
  /** The document on screen (resolveCanvasItem), or null when empty. */
  selected: string | null;
  files: readonly OpenFile[];
  /** The conversation's canvas, when it is one of `items`. */
  channelCanvas: {
    channelId: string;
    doc: ChannelCanvasDoc | null;
    phase?: ChannelCanvasPhase;
  } | null;
  expanded: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onOpenShelf: (() => void) | null;
}) {
  if (items.length === 0) {
    return <CanvasEmpty onOpenShelf={onOpenShelf} />;
  }
  const byKey = new Map(files.map((file) => [file.key, file]));
  const file = selected === null ? null : (byKey.get(selected) ?? null);

  return (
    <div
      data-testid="canvas-pane"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div
        role="tablist"
        aria-label="Canvas documents"
        data-testid="canvas-tabs"
        className="flex h-10 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-background px-2 [scrollbar-width:none]"
      >
        {items.map((key) => {
          if (key === CHANNEL_CANVAS_KEY) {
            return (
              <CanvasTab
                key={key}
                label="Channel canvas"
                title="This conversation's canvas"
                icon={<ChannelCanvasIcon />}
                mono={false}
                selected={selected === key}
                onSelect={() => onSelect(key)}
                onClose={null}
              />
            );
          }
          const open = byKey.get(key);
          if (!open) {
            return null;
          }
          return (
            <CanvasTab
              key={key}
              label={open.filename}
              title={open.filename}
              icon={
                <FileIcon kind={fileKind(open.filename, open.mime)} size="xs" />
              }
              mono
              selected={selected === key}
              onSelect={() => onSelect(key)}
              onClose={() => onClose(key)}
            />
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {selected === CHANNEL_CANVAS_KEY && channelCanvas ? (
          <ChannelCanvasView
            key={channelCanvas.channelId}
            channelId={channelCanvas.channelId}
            doc={channelCanvas.doc}
            expanded={expanded}
            phase={channelCanvas.phase}
          />
        ) : file ? (
          <FilePreview
            key={file.key}
            file={file}
            variant={expanded ? "expanded" : "dock"}
          />
        ) : null}
      </div>
    </div>
  );
}
