import { ArrowRight } from "lucide-react";
import { StateHex } from "@/shared/ui/HexAvatar";
import type { AgentReceipt } from "../lib/reactions.ts";

/**
 * The task a `/handoff` message hands over: everything after the leading
 * `@Seat` the command wrote. A message that carries the tag but not that
 * shape (another client's handoff) shows its whole text as the task.
 */
export function handoffTask(content: string, seatName: string): string {
  const lead = `@${seatName}`.toLowerCase();
  const trimmed = content.trimStart();
  if (seatName !== "" && trimmed.toLowerCase().startsWith(lead)) {
    return trimmed.slice(lead.length).trim();
  }
  return content.trim();
}

/**
 * A tracked handoff, as one bar (Main artboard): HANDOFF · the seat · the
 * task · where it stands.
 *
 * "Where it stands" is the seat's own 👀 / 💬 receipt on this message and
 * nothing else — queued when it has seen it, working while it responds. When
 * the agent clears its receipt (the turn ended) the bar goes back to saying
 * nothing, because nothing in the data says "done": a Done claim here would
 * be a guess until task status events exist (Phase 8).
 */
export function HandoffChip({
  seatName,
  task,
  receipt,
}: {
  seatName: string;
  task: string;
  receipt: AgentReceipt;
}) {
  return (
    <div
      data-testid="handoff-chip"
      className="mt-1.5 flex max-w-2xl flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-honey-line bg-honey-wash px-3 py-2"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-badge font-semibold tracking-[0.1em] text-honey-ink">
        <ArrowRight aria-hidden className="size-3.75" />
        HANDOFF
      </span>
      <b className="shrink-0 text-sidebar-meta font-semibold">{seatName}</b>
      <span className="min-w-0 flex-1 basis-40 text-sidebar-meta text-ink-2">
        {task}
      </span>
      {receipt && (
        <span
          data-testid="handoff-status"
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-2xs font-semibold text-honey-ink"
        >
          <StateHex
            tone={receipt === "responding" ? "work" : "idle"}
            size={8}
            pulse={receipt === "responding"}
          />
          {receipt === "responding" ? "Accepted · working" : "Queued"}
        </span>
      )}
    </div>
  );
}
