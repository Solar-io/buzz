import { useState } from "react";
import { AlarmClock, ChevronDown, ChevronRight } from "lucide-react";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import { formatClockTime } from "../lib/dateFormatters.ts";
import { wakePreview } from "../lib/wakeMessage.ts";
import { cn } from "@/shared/lib/cn";

/**
 * The collapsed rendering for scheduled-wake messages (see lib/wakeMessage.ts
 * for why these are machinery, not conversation). Collapsed: one muted line —
 * marker, sender, a squeezed preview of the instruction, time, chevron — so a
 * stack of wakes reads as a checklist instead of a wall of internals. Tap
 * expands the full instruction text verbatim (pre-wrap, no markdown — the
 * text is a runbook line for a woken seat, and rendering it as prose would
 * quietly reformat the only copy a debugging human has).
 *
 * Rendered inside MessageRow's outer shell, so permalink jumps, highlight
 * flashes and the row testid all keep working for wake rows too.
 */
export function ScheduledWakeRow({
  message,
  label,
}: {
  message: TimelineMessage;
  /** Author display name ("Buzz Services") — resolved by the row's caller. */
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="min-w-0 flex-1 py-1">
      <button
        type="button"
        data-testid="scheduled-wake-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <AlarmClock className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">Scheduled wake</span>
        <span className="shrink-0 opacity-60">·</span>
        <span className="shrink-0 opacity-80">{label}</span>
        <span className="shrink-0 opacity-60">·</span>
        <span
          data-testid="scheduled-wake-preview"
          className="min-w-0 flex-1 truncate opacity-70"
        >
          {wakePreview(message.content)}
        </span>
        <span className="shrink-0 tabular-nums opacity-60">
          {formatClockTime(message.createdAt)}
        </span>
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
      </button>
      {expanded && (
        <div
          data-testid="scheduled-wake-body"
          className={cn(
            "mx-1 mt-1 overflow-x-auto rounded-lg border border-border/60 bg-muted/30 px-3 py-2",
            "font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground",
          )}
        >
          {message.content}
        </div>
      )}
    </div>
  );
}
