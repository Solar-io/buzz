import { ChevronRight } from "lucide-react";
import type { Profile } from "../hooks.ts";
import { formatLastReplyTime } from "../lib/threadSummary.ts";
import type { ThreadBranchSummary } from "../lib/threadTree.ts";
import { ThreadParticipantStack } from "./ThreadParticipantStack.tsx";

/**
 * The collapsed sub-branch row: "3 replies · last reply 5 minutes ago" with
 * the branch's recent participants, sitting under the reply that owns it.
 *
 * This is what makes nesting readable instead of a wall of indents — the
 * desktop's `buildSummaryForDirectReplies` chip. Clicking it expands the
 * branch in place; it does not open a new thread, because the branch is part
 * of the thread already on screen.
 */
export function ThreadBranchChip({
  summary,
  profiles,
  onExpand,
}: {
  summary: ThreadBranchSummary;
  profiles: Map<string, Profile>;
  onExpand: (parentId: string) => void;
}) {
  const label = `${summary.replyCount} ${
    summary.replyCount === 1 ? "reply" : "replies"
  }`;
  return (
    <button
      type="button"
      data-testid="thread-branch-chip"
      data-branch-parent={summary.parentId}
      aria-label={`Expand ${label}`}
      className="mt-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={(event) => {
        // The chip lives inside a row whose own click opens the thread;
        // expanding a branch must not also re-target the panel.
        event.stopPropagation();
        onExpand(summary.parentId);
      }}
    >
      <ThreadParticipantStack
        // No "+N" here: the reply count next to the stack already says how
        // big the branch is, and a second number beside it reads as a
        // contradiction rather than as extra information.
        participants={{
          shown: summary.participants,
          overflow: 0,
          total: summary.participants.length,
        }}
        profiles={profiles}
      />
      <span className="font-medium text-primary">{label}</span>
      {summary.lastReplyAt !== null && (
        <span className="truncate">
          · last reply {formatLastReplyTime(summary.lastReplyAt)}
        </span>
      )}
      <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
    </button>
  );
}
