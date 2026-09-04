/**
 * The issue list for one repository, with a master/detail split.
 *
 * Filtering is by NIP-34 lifecycle rather than by the desktop's board label,
 * because the lifecycle is the part the protocol actually carries and the part
 * a transition changes; the board label is a reading of `t` tags and belongs on
 * the row, not in the filter.
 */

import { CircleDot, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { useProjectIssues } from "../hooks.ts";
import type { IssueLifecycle, ProjectIssue } from "../lib/projectIssues.ts";
import type { Repository } from "../lib/projectModels.ts";
import { CreateIssueDialog } from "./CreateIssueDialog.tsx";
import { IssueDetail } from "./IssueDetail.tsx";
import {
  IncompleteCollectionNotice,
  IssueLifecycleBadge,
  LIFECYCLE_LABEL,
} from "./projectPresentation.tsx";

type LifecycleFilter = "all" | IssueLifecycle;

const FILTERS: LifecycleFilter[] = [
  "all",
  "open",
  "draft",
  "resolved",
  "closed",
];

/** An issue with no status event counts as open, matching the badge. */
function matchesFilter(issue: ProjectIssue, filter: LifecycleFilter): boolean {
  if (filter === "all") return true;
  return (issue.lifecycle ?? "open") === filter;
}

export function IssuesPanel({
  repository,
  viewerPubkey,
}: {
  repository: Repository | null;
  viewerPubkey: string | null;
}) {
  const { data, isLoading, error } = useProjectIssues(repository?.repoAddress);
  const [filter, setFilter] = useState<LifecycleFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const issues = useMemo(
    () => (data?.issues ?? []).filter((issue) => matchesFilter(issue, filter)),
    [data?.issues, filter],
  );
  const selected =
    data?.issues.find((issue) => issue.id === selectedId) ?? null;

  if (selected) {
    return (
      <div className="flex flex-col gap-3">
        <Button
          className="self-start"
          onClick={() => setSelectedId(null)}
          size="sm"
          type="button"
          variant="ghost"
        >
          ← All issues
        </Button>
        <IssueDetail
          issue={selected}
          repository={repository}
          viewerPubkey={viewerPubkey}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <Button
              data-testid={`issue-filter-${option}`}
              key={option}
              onClick={() => setFilter(option)}
              size="sm"
              type="button"
              variant={filter === option ? "secondary" : "ghost"}
            >
              {option === "all" ? "All" : LIFECYCLE_LABEL[option]}
            </Button>
          ))}
        </div>
        <Button
          data-testid="new-issue"
          disabled={!repository || !viewerPubkey}
          onClick={() => setCreating(true)}
          size="sm"
          type="button"
        >
          <Plus />
          New issue
        </Button>
      </div>

      {data?.possiblyIncomplete ? (
        <IncompleteCollectionNotice what="issues" />
      ) : null}
      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          {error.message}
        </p>
      ) : null}

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : issues.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-border/70 px-4 py-10 text-center"
          data-testid="issues-empty"
        >
          <CircleDot className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            {filter === "all"
              ? "No issues have been filed against this repository."
              : `No ${LIFECYCLE_LABEL[filter].toLowerCase()} issues.`}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="issue-list">
          {issues.map((issue) => (
            <li key={issue.id}>
              <button
                className="flex w-full flex-col gap-1 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-muted/40"
                data-testid="issue-row"
                onClick={() => setSelectedId(issue.id)}
                type="button"
              >
                <div className="flex items-center gap-2">
                  <IssueLifecycleBadge lifecycle={issue.lifecycle} />
                  <span className="truncate text-sm font-medium text-foreground">
                    {issue.title}
                  </span>
                </div>
                <span className="text-2xs text-muted-foreground">
                  {issue.status} · updated {relativeTime(issue.updatedAt)}
                  {issue.comments.length > 0
                    ? ` · ${issue.comments.length} comment${issue.comments.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <CreateIssueDialog
        onOpenChange={setCreating}
        open={creating}
        repository={repository}
      />
    </div>
  );
}
