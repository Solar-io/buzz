import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import type { WorkflowSummary } from "../lib/workflowDefinition.ts";
import { actionLabel } from "../lib/workflowDefinition.ts";
import { useRunApprovals, useWorkflowRuns } from "../useWorkflowRuns.ts";
import { useWorkflowActions } from "../useWorkflowActions.ts";
import { WorkflowRunTrace } from "./WorkflowRunTrace.tsx";

type Props = {
  workflow: WorkflowSummary;
  viewerPubkey: string | null;
};

type Tab = "runs" | "definition";

/** The definition as the author wrote it, plus a step-by-step reading of it. */
function DefinitionTab({ workflow }: { workflow: WorkflowSummary }) {
  return (
    <div className="space-y-3">
      {workflow.steps.length > 0 ? (
        <ol className="space-y-2">
          {workflow.steps.map((step, index) => (
            <li
              className="rounded-lg border border-border/60 bg-background/70 p-3"
              key={step.key}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Step {index + 1}
                </span>
                <span className="font-mono text-xs">{step.id}</span>
                <span className="text-xs font-medium">
                  {actionLabel(step.action)}
                </span>
              </div>
              {step.name !== null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {step.name}
                </p>
              ) : null}
              {step.condition !== null ? (
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  if {step.condition}
                </p>
              ) : null}
              {step.fields.length > 0 ? (
                <dl className="mt-2 space-y-1">
                  {step.fields.map((field) => (
                    <div className="flex gap-2 text-xs" key={field.key}>
                      <dt className="shrink-0 font-mono text-muted-foreground">
                        {field.key}
                      </dt>
                      <dd className="min-w-0 whitespace-pre-wrap break-words">
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <div>
        <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          YAML
        </p>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-xs">
          {workflow.yaml === "" ? "(empty definition)" : workflow.yaml}
        </pre>
      </div>
    </div>
  );
}

/**
 * Run history for one workflow, and the trace of whichever run is selected.
 *
 * Runs and approvals are relay-owned rows read over authenticated HTTP; the
 * approvals call fires only for the selected run, and only while that run is
 * parked on an approval gate, since it is a second signed request.
 */
export function WorkflowRunsPanel({ workflow, viewerPubkey }: Props) {
  const [tab, setTab] = useState<Tab>("runs");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runsQuery = useWorkflowRuns(workflow.id);
  const { decideApproval } = useWorkflowActions();

  const runs = runsQuery.data?.runs ?? [];
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;

  // Follow the newest run when the list changes and nothing is pinned.
  useEffect(() => {
    if (
      selectedRunId !== null &&
      !runs.some((run) => run.id === selectedRunId)
    ) {
      setSelectedRunId(null);
    }
  }, [runs, selectedRunId]);

  const approvalsQuery = useRunApprovals(
    workflow.id,
    selectedRun?.id ?? null,
    selectedRun?.status === "waiting_approval",
  );

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <Button
          size="xs"
          variant={tab === "runs" ? "secondary" : "ghost"}
          onClick={() => setTab("runs")}
          data-testid="workflow-tab-runs"
        >
          Runs
        </Button>
        <Button
          size="xs"
          variant={tab === "definition" ? "secondary" : "ghost"}
          onClick={() => setTab("definition")}
          data-testid="workflow-tab-definition"
        >
          Definition
        </Button>
      </div>

      {tab === "definition" ? (
        <DefinitionTab workflow={workflow} />
      ) : runsQuery.isPending ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Loading run history…
        </p>
      ) : runsQuery.isError ? (
        <p className="text-xs text-destructive" role="alert">
          {runsQuery.error instanceof Error
            ? runsQuery.error.message
            : "Could not read run history."}
        </p>
      ) : runs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
          This workflow has not run yet.
        </p>
      ) : (
        <div className="space-y-3">
          {runs.length > 1 ? (
            <div
              className="flex flex-wrap gap-1"
              data-testid="workflow-run-picker"
            >
              {runs.map((run) => (
                <Button
                  key={run.id}
                  size="xs"
                  variant={run.id === selectedRun?.id ? "secondary" : "ghost"}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <span className="font-mono">{run.id.slice(0, 8)}</span>
                </Button>
              ))}
            </div>
          ) : null}
          {selectedRun !== null ? (
            <WorkflowRunTrace
              run={selectedRun}
              approvals={approvalsQuery.data ?? []}
              viewerPubkey={viewerPubkey}
              onDecideApproval={(approvalRef, approved) =>
                decideApproval(approvalRef, approved)
              }
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
