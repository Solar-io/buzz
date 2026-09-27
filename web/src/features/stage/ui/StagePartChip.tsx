import { Clapperboard } from "lucide-react";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";

/**
 * A small "Stage · frame 3" chip on a part row in the normal timeline. The
 * row is otherwise an ordinary image message (req 6).
 *
 * Deviation from the design's "3/8": a row sees one event, and the palette
 * size lives on the OPEN event, so the chip names the frame rather than
 * inventing a total. Since §15 a part is a showing of a palette frame (they
 * repeat, in any order), so "k of N" would mislead anyway.
 */
export function StagePartChip({ message }: { message: TimelineMessage }) {
  const tag = message.stage;
  if (tag?.op !== "part" || typeof tag.i !== "number") return null;
  return (
    <span
      data-testid="stage-part-chip"
      className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-badge font-medium text-muted-foreground"
    >
      <Clapperboard className="h-3 w-3" aria-hidden />
      Stage · frame {tag.i + 1}
    </span>
  );
}
