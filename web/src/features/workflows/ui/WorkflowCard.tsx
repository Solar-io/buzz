import { useState } from "react";
import { ChevronDown, ChevronRight, Hash, Play } from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Spinner } from "@/shared/ui/spinner";
import { relativeTime } from "@/shared/lib/relative-time";
import {
  actionLabel,
  triggerDescription,
  type WorkflowSummary,
} from "../lib/workflowDefinition.ts";
import {
  latestRun,
  type WorkflowRun,
  type WorkflowRunsPage,
} from "../lib/workflowRuns.ts";
import { canTrigger } from "../lib/workflowTrigger.ts";
import { WorkflowRunsPanel } from "./WorkflowRunsPanel.tsx";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge.tsx";

type Props = {
  workflow: WorkflowSummary;
  channelName: string | null;
  viewerPubkey: string | null;
  /** Last-run page for this workflow, when the list has one. */
  lastRunPage: WorkflowRunsPage | undefined;
  onTrigger: (workflow: WorkflowSummary) => Promise<void>;
};

function LastRunLine({ run }: { run: WorkflowRun | null }) {
  if (run === null) {
    return <span className="text-xs text-muted-foreground">No runs yet</span>;
  }
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <WorkflowStatusBadge status={run.status} />
      {relativeTime(run.createdAt)}
    </span>
  );
}

/**
 * One workflow in the list: what fires it, what it does, whether it is enabled,
 * and how its last run went. Expanding reveals the run history and each run's
 * step trace.
 */
export function WorkflowCard({
  workflow,
  channelName,
  viewerPubkey,
  lastRunPage,
  onTrigger,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runnable = canTrigger(
    workflow.ownerPubkey,
    workflow.enabled,
    viewerPubkey,
  );

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await onTrigger(workflow);
      setExpanded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The run failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="overflow-hidden" data-testid="workflow-card">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-0.5 rounded-md p-0.5 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
          data-testid="workflow-card-toggle"
        >
          {expanded ? (
            <ChevronDown aria-hidden className="h-4 w-4" />
          ) : (
            <ChevronRight aria-hidden className="h-4 w-4" />
          )}
          <span className="sr-only">
            {expanded ? "Hide" : "Show"} runs for {workflow.name}
          </span>
        </button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{workflow.name}</h2>
            <Badge variant={workflow.enabled ? "success" : "secondary"}>
              {workflow.enabled ? "Enabled" : "Disabled"}
            </Badge>
            {channelName !== null ? (
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                <Hash aria-hidden className="h-3 w-3" />
                {channelName}
              </span>
            ) : null}
          </div>

          {workflow.description !== null ? (
            <p className="text-xs text-muted-foreground">
              {workflow.description}
            </p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {triggerDescription(workflow.trigger)}
          </p>

          {workflow.parseError !== null ? (
            <p className="text-xs text-destructive" role="alert">
              {workflow.parseError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {workflow.steps.length === 0
                ? "No steps"
                : workflow.steps
                    .map((step) => actionLabel(step.action))
                    .join(" → ")}
            </p>
          )}

          <div className="pt-1">
            <LastRunLine
              run={
                lastRunPage === undefined ? null : latestRun(lastRunPage.runs)
              }
            />
          </div>
        </div>

        {runnable ? (
          <Button
            size="sm"
            variant="outline"
            disabled={running}
            onClick={() => void run()}
            data-testid="workflow-run-now"
          >
            {running ? (
              <Spinner className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Play aria-hidden className="mr-1 h-3.5 w-3.5" />
            )}
            Run now
          </Button>
        ) : null}
      </div>

      {error !== null ? (
        <p className="px-4 pb-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {expanded ? (
        <div className="border-t border-border/60 bg-muted/20 p-4">
          <WorkflowRunsPanel workflow={workflow} viewerPubkey={viewerPubkey} />
        </div>
      ) : null}
    </Card>
  );
}
