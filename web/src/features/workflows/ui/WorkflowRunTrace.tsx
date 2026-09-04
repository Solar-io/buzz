import { formatDuration, type WorkflowRun } from "../lib/workflowRuns.ts";
import type { WorkflowApproval } from "../lib/workflowApprovals.ts";
import { WorkflowApprovalCard } from "./WorkflowApprovalCard.tsx";
import {
  WorkflowStatusBadge,
  WorkflowStatusIcon,
} from "./WorkflowStatusBadge.tsx";

type Props = {
  run: WorkflowRun;
  approvals: WorkflowApproval[];
  viewerPubkey: string | null;
  onDecideApproval: (approvalRef: string, approved: boolean) => Promise<void>;
};

/**
 * One run's step-by-step trace.
 *
 * The entries come from the run row's `execution_trace`, which the executor
 * appends to as each step settles — so a step that has not run yet has no
 * entry at all. An empty trace is therefore a real state (a queued run, or one
 * that failed before its first step), not a loading state, and it says so.
 */
export function WorkflowRunTrace({
  run,
  approvals,
  viewerPubkey,
  onDecideApproval,
}: Props) {
  return (
    <div className="space-y-3" data-testid="workflow-run-trace">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{run.id.slice(0, 8)}</span>
        <WorkflowStatusBadge status={run.status} />
        <span>{new Date(run.createdAt * 1000).toLocaleString()}</span>
        {formatDuration(run.startedAt, run.completedAt) !== null ? (
          <span>took {formatDuration(run.startedAt, run.completedAt)}</span>
        ) : null}
      </div>

      {run.errorMessage !== null ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-destructive">
            {run.errorCode ?? "Run failed"}
          </p>
          <p className="mt-1 break-words text-xs text-destructive">
            {run.errorMessage}
          </p>
        </div>
      ) : null}

      {run.trace.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
          No steps recorded for this run.
        </p>
      ) : (
        run.trace.map((step) => {
          const duration = formatDuration(step.startedAt, step.completedAt);
          const gate = approvals.find(
            (approval) =>
              approval.stepId === step.stepId && approval.status === "pending",
          );
          const outputKeys = Object.keys(step.output);
          return (
            <div
              className="rounded-lg border border-border/60 bg-background/70 p-3"
              key={step.key}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <WorkflowStatusIcon status={step.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                  {step.stepId}
                </span>
                <WorkflowStatusBadge status={step.status} />
                {duration !== null ? (
                  <span className="text-xs text-muted-foreground">
                    {duration}
                  </span>
                ) : null}
              </div>

              {outputKeys.length > 0 ? (
                <div className="mt-3">
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Output
                  </p>
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                    {JSON.stringify(step.output, null, 2)}
                  </pre>
                </div>
              ) : null}

              {step.error !== null ? (
                <div className="mt-3">
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.16em] text-destructive">
                    Error
                  </p>
                  <pre className="max-h-40 overflow-auto rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                    {step.error}
                  </pre>
                </div>
              ) : null}

              {gate !== undefined ? (
                <div className="mt-3">
                  <WorkflowApprovalCard
                    approval={gate}
                    viewerPubkey={viewerPubkey}
                    onDecide={(approved) =>
                      onDecideApproval(gate.approvalRef, approved)
                    }
                  />
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
