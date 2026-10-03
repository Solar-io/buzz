import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { readMinutes } from "@/features/shelf/lib/fileKind.ts";
import { whenLabel } from "@/features/shelf/lib/shelfView.ts";
import { useShareNames } from "@/features/shelf/useShareNames.ts";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { Textarea } from "@/shared/ui/textarea";
import {
  hasCanvasContent,
  type ChannelCanvasDoc,
  type ChannelCanvasPhase,
} from "../lib/channelCanvas.ts";
import { useCanvasEdit } from "../useCanvasEdit.ts";

const NO_MENTIONS: ReadonlySet<string> = new Set();

/**
 * The conversation's channel canvas, read in the right pane's Canvas tab:
 * whose canvas it is, who set it and when, then the markdown — the same
 * renderer and type scale as a markdown file beside it. Members can append
 * markdown updates through the relay; the live echo supplies the new content.
 */
export function ChannelCanvasView({
  channelId,
  doc,
  expanded,
  phase = doc ? "ready" : "loading",
}: {
  channelId: string;
  /** Null while the first REQ is still out. */
  doc: ChannelCanvasDoc | null;
  expanded: boolean;
  phase?: ChannelCanvasPhase;
}) {
  const edit = useCanvasEdit(channelId, doc);
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
      <header className="shrink-0 border-b border-border px-4 py-3">
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {edit.canEdit && phase === "ready" ? (
            edit.editing ? (
              <>
                <Button
                  type="button"
                  disabled={edit.busy}
                  onClick={() => void edit.save()}
                  className="min-h-11"
                >
                  {edit.busy ? "Saving…" : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={edit.busy}
                  onClick={edit.cancel}
                  className="min-h-11"
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={edit.busy}
                onClick={edit.start}
                className="min-h-11"
              >
                Edit
              </Button>
            )
          ) : null}
          {edit.canEdit && hasCanvasContent(doc) ? (
            <Button
              type="button"
              variant="ghost"
              disabled={edit.busy}
              onClick={edit.clear}
              className="min-h-11 text-coral-ink"
            >
              Clear
            </Button>
          ) : null}
        </div>
        {edit.error ? (
          <p role="alert" className="mt-2 break-words text-sm text-coral-ink">
            {edit.error}
          </p>
        ) : null}
        {edit.changedElsewhere ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            The canvas changed while you were editing. Saving will replace it.
          </p>
        ) : null}
      </header>
      <div className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn("px-4 py-4", expanded && "mx-auto w-full max-w-5xl")}
        >
          {edit.editing ? (
            <Textarea
              aria-label="Canvas markdown"
              autoFocus
              spellCheck
              value={edit.draft}
              disabled={edit.busy || !edit.canEdit}
              onChange={(event) => edit.setDraft(event.target.value)}
              className="min-h-64 resize-y font-mono"
              placeholder="Write this channel’s canvas in Markdown…"
            />
          ) : hasCanvasContent(doc) && doc ? (
            <div
              data-testid="channel-canvas-body"
              className="[&_h1]:font-serif [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:text-base [&_h2]:font-semibold"
            >
              <MarkdownContent
                content={doc.content}
                mentionNames={NO_MENTIONS}
              />
            </div>
          ) : phase === "ready" ? (
            <p
              data-testid="channel-canvas-empty"
              className="text-sm text-muted-foreground"
            >
              No canvas yet.{" "}
              {edit.canEdit
                ? "Choose Edit to write one."
                : "A channel member can add one."}
            </p>
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
