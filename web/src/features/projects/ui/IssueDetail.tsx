/**
 * One issue: its markdown body, its conversation, and the control that moves
 * it between NIP-34 lifecycle states.
 *
 * A transition is a whole signed event, not a field update — kind 1630/1631/
 * 1632/1633 with the issue as its `e` root — and the relay stores every one of
 * them, so "reopen" is simply a later kind:1630. Only the issue author and the
 * repository owner are trusted on read, which is why a viewer who is neither
 * gets no transition menu rather than a menu whose result would be discarded.
 */

import { ChevronDown, MessageSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useProfiles } from "@/features/channels/hooks";
import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Separator } from "@/shared/ui/separator";
import { Textarea } from "@/shared/ui/textarea";
import { usePostIssueComment, useSetIssueLifecycle } from "../hooks.ts";
import {
  availableLifecycleTransitions,
  projectTaskUserLabels,
  type IssueLifecycle,
  type ProjectIssue,
} from "../lib/projectIssues.ts";
import type { Repository } from "../lib/projectModels.ts";
import {
  IssueLifecycleBadge,
  LIFECYCLE_LABEL,
} from "./projectPresentation.tsx";

const NO_MENTIONS: ReadonlySet<string> = new Set();

function AuthorLine({
  createdAt,
  label,
}: {
  createdAt: number;
  label: string;
}) {
  return (
    <span className="text-2xs text-muted-foreground">
      {label} · {relativeTime(createdAt)}
    </span>
  );
}

export function IssueDetail({
  issue,
  repository,
  viewerPubkey,
}: {
  issue: ProjectIssue;
  repository: Repository | null;
  viewerPubkey: string | null;
}) {
  const [draft, setDraft] = useState("");
  const setLifecycle = useSetIssueLifecycle(repository);
  const postComment = usePostIssueComment(repository);

  const participants = [
    issue.author,
    ...issue.comments.map((comment) => comment.author),
  ];
  const profiles = useProfiles(participants);
  const labelFor = (pubkey: string) =>
    profiles.get(pubkey)?.displayName ?? truncatePubkey(pubkey);

  // The same trust rule the read path applies (`allowedActorsForRoot`):
  // offering the menu to anyone else would publish an event every client
  // ignores.
  const canMove =
    viewerPubkey !== null &&
    (viewerPubkey === issue.author.toLowerCase() ||
      viewerPubkey === repository?.owner);

  const move = async (lifecycle: IssueLifecycle) => {
    try {
      await setLifecycle.mutateAsync({ issue, lifecycle });
      toast.success(`Marked ${LIFECYCLE_LABEL[lifecycle]}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update the issue.",
      );
    }
  };

  const comment = async () => {
    try {
      await postComment.mutateAsync({ body: draft, issue });
      setDraft("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not post the comment.",
      );
    }
  };

  const userLabels = projectTaskUserLabels(issue.labels);

  return (
    <div className="flex flex-col gap-4" data-testid="issue-detail">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <IssueLifecycleBadge lifecycle={issue.lifecycle} />
          <Badge variant="outline">{issue.category}</Badge>
          {userLabels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
          {canMove ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  data-testid="issue-lifecycle-trigger"
                  size="sm"
                  variant="outline"
                >
                  Change state
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {availableLifecycleTransitions(issue.lifecycle).map(
                  (lifecycle) => (
                    <DropdownMenuItem
                      data-testid={`issue-lifecycle-${lifecycle}`}
                      key={lifecycle}
                      onSelect={() => void move(lifecycle)}
                    >
                      {LIFECYCLE_LABEL[lifecycle]}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <h2 className="text-lg font-semibold text-foreground">{issue.title}</h2>
        <AuthorLine
          createdAt={issue.createdAt}
          label={labelFor(issue.author)}
        />
      </div>

      {issue.content.trim() ? (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <MarkdownContent content={issue.content} mentionNames={NO_MENTIONS} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}

      <Separator />

      <div className="flex flex-col gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <MessageSquare className="h-4 w-4" />
          {issue.comments.length === 1
            ? "1 comment"
            : `${issue.comments.length} comments`}
        </h3>
        {issue.comments.map((entry) => (
          <div
            className="flex flex-col gap-1 rounded-lg border border-border/50 bg-card/60 p-3"
            data-testid="issue-comment"
            key={entry.id}
          >
            <AuthorLine
              createdAt={entry.createdAt}
              label={labelFor(entry.author)}
            />
            <MarkdownContent
              content={entry.content}
              mentionNames={NO_MENTIONS}
            />
          </div>
        ))}

        <div className="flex flex-col gap-2">
          <Textarea
            data-testid="issue-comment-input"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a comment"
            rows={3}
            value={draft}
          />
          <div className="flex justify-end">
            <Button
              data-testid="issue-comment-submit"
              disabled={draft.trim().length === 0 || postComment.isPending}
              onClick={() => void comment()}
              size="sm"
              type="button"
            >
              {postComment.isPending ? "Posting…" : "Comment"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
