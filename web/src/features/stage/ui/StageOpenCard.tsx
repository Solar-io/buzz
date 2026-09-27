import { Clapperboard, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { Skeleton } from "@/shared/ui/skeleton";
import { launchStage } from "../lib/stageLauncher.ts";
import type { StageOpenTag } from "../lib/stageTag.ts";
import { useStageImage } from "./useStageImage.ts";

/**
 * The open tag of a timeline message when it is renderable as a Stage card.
 * Structural check, not truthiness: a row restored from an older timeline
 * cache may carry a `stage` field that never went through the parser, and
 * that must fall back to plain markdown rather than crash the row.
 */
export function stageOpenCardTag(
  message: TimelineMessage,
): StageOpenTag | null {
  const tag = message.stage;
  if (
    tag?.op !== "open" ||
    typeof tag.title !== "string" ||
    !Array.isArray(tag.parts) ||
    tag.parts.length === 0
  ) {
    return null;
  }
  return tag;
}

/**
 * Timeline card for a Stage open event (design §7, like `DecisionCard`):
 * title, frame count, the cover (palette[0] — the ONLY frame the timeline
 * preloads, so a channel full of old decks never pulls 100 MB), and the two
 * entries. Both buttons unlock audio inside the tap (`launchStage`).
 */
export function StageOpenCard({ message }: { message: TimelineMessage }) {
  const tag = stageOpenCardTag(message);
  const cover = useStageImage(tag?.parts[0]?.url);
  if (!tag) return null;
  const frames = tag.parts.length;
  const open = (mode: "live" | "replay") =>
    launchStage(message.id, message.channelId, mode);
  return (
    <div
      data-testid="stage-open-card"
      className="my-1 max-w-md overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="relative aspect-video w-full bg-muted">
        {cover.objectUrl ? (
          <img
            src={cover.objectUrl}
            alt={`${tag.title} cover`}
            className="absolute inset-0 h-full w-full object-cover"
            decoding="async"
          />
        ) : cover.failed ? null : (
          <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
        )}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Clapperboard className="h-4 w-4 shrink-0" aria-hidden />
          <span data-testid="stage-open-card-title" className="truncate">
            {tag.title}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span data-testid="stage-open-card-count">
            {frames} {frames === 1 ? "frame" : "frames"}
          </span>
          <span aria-hidden>·</span>
          {tag.voice ? (
            <span className="inline-flex items-center gap-1">
              <Volume2 className="h-3 w-3" aria-hidden /> voice
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <VolumeX className="h-3 w-3" aria-hidden /> no voice
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="stage-open-button"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => open("live")}
          >
            <Play className="h-4 w-4" aria-hidden /> Open Stage
          </button>
          <button
            type="button"
            data-testid="stage-replay-button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            onClick={() => open("replay")}
          >
            <RotateCcw className="h-4 w-4" aria-hidden /> Replay
          </button>
        </div>
      </div>
    </div>
  );
}
