import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  isActionable,
  isExpired,
  type WorkflowApproval,
} from "../lib/workflowApprovals.ts";

type Props = {
  approval: WorkflowApproval;
  viewerPubkey: string | null;
  onDecide: (approved: boolean) => Promise<void>;
};

function approverLabel(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "any") return "anyone in this community";
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return truncatePubkey(trimmed);
  return trimmed;
}

/**
 * A workflow step parked on an approval gate.
 *
 * Grant and deny are ordinary signed events (46030 / 46031) that a browser can
 * publish, so the buttons are real rather than a placeholder. They appear only
 * when the relay would accept the event — pending, unexpired, and the viewer
 * satisfying `approver_spec` — which mirrors `check_approver_spec` exactly.
 */
export function WorkflowApprovalCard({
  approval,
  viewerPubkey,
  onDecide,
}: Props) {
  const [pending, setPending] = useState<"grant" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionable = isActionable(approval, viewerPubkey);
  const expired = isExpired(approval);

  const decide = async (approved: boolean) => {
    setPending(approved ? "grant" : "deny");
    setError(null);
    try {
      await onDecide(approved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
      data-testid="workflow-approval-card"
    >
      <p className="text-sm font-medium">Approval required</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Step <span className="font-mono">{approval.stepId}</span> — approver:{" "}
        {approverLabel(approval.approverSpec)}
      </p>
      {approval.expiresAt !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {expired ? "Expired" : "Expires"}{" "}
          {new Date(approval.expiresAt).toLocaleString()}
        </p>
      ) : null}
      {approval.note !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">{approval.note}</p>
      ) : null}

      {actionable ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pending !== null}
            onClick={() => void decide(true)}
          >
            {pending === "grant" ? "Approving…" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void decide(false)}
          >
            {pending === "deny" ? "Denying…" : "Deny"}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {approval.status !== "pending"
            ? `Already ${approval.status}.`
            : expired
              ? "This approval window has closed."
              : "You are not the designated approver for this step."}
        </p>
      )}
      {error !== null ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
