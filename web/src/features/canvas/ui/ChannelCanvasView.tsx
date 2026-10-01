import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { readMinutes } from "@/features/shelf/lib/fileKind.ts";
import { whenLabel } from "@/features/shelf/lib/shelfView.ts";
import { useShareNames } from "@/features/shelf/useShareNames.ts";
import { cn } from "@/shared/lib/cn";
import { Skeleton } from "@/shared/ui/skeleton";
import type { ChannelCanvasDoc } from "../lib/channelCanvas.ts";

const NO_MENTIONS: ReadonlySet<string> = new Set();

/**
 * The conversation's channel canvas, read in the right pane's Canvas tab:
 * whose canvas it is, who set it and when, then the markdown — the same
 * renderer and type scale as a markdown file beside it. Read-only here; it
 * is written with `buzz canvas set` or the desktop's channel sheet.
 */
export function ChannelCanvasView({
  channelId,
  doc,
  expanded,
}: {
  channelId: string;
  /** Null while the first REQ is still out. */
  doc: ChannelCanvasDoc | null;
  expanded: boolean;
}) {
  const names = useShareNames(doc ? [doc.authorPubkey] : []);
  const where = names.channel(channelId);
  const meta = [
    where.startsWith("DM ") ? "DM canvas" : "channel canvas",
    doc ? `${readMinutes(doc.content)} min read` : null,
  ].filter(Boolean);

  return (
    <section
      data-testid="channel-canvas"
      aria-label={`Canvas for ${where}`}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2
            data-testid="channel-canvas-title"
            className="max-w-full truncate text-sm font-semibold"
          >
            {where}
          </h2>
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">
            {meta.join(" · ")}
          </span>
        </div>
        {doc ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Updated by {names.person(doc.authorPubkey)} ·{" "}
            {whenLabel(doc.updatedAt, Math.floor(Date.now() / 1000))}
          </p>
        ) : null}
      </header>
      <div className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn("px-4 py-4", expanded && "mx-auto w-full max-w-5xl")}
        >
          {doc ? (
            <div
              data-testid="channel-canvas-body"
              className="[&_h1]:font-serif [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:text-base [&_h2]:font-semibold"
            >
              <MarkdownContent
                content={doc.content}
                mentionNames={NO_MENTIONS}
              />
            </div>
          ) : (
            <div
              data-testid="channel-canvas-loading"
              className="flex flex-col gap-2"
            >
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
