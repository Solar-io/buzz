import { useEffect, useMemo, useState } from "react";
import { Workflow as WorkflowIcon } from "lucide-react";

import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import type { WorkflowSummary } from "../lib/workflowDefinition.ts";
import { useLatestRuns } from "../useWorkflowRuns.ts";
import { useWorkflowActions } from "../useWorkflowActions.ts";
import { useWorkflows } from "../useWorkflows.ts";
import { WorkflowCard } from "./WorkflowCard.tsx";

function matches(workflow: WorkflowSummary, needle: string): boolean {
  if (needle === "") return true;
  const haystack = [
    workflow.name,
    workflow.description ?? "",
    workflow.trigger.on ?? "",
    ...workflow.steps.map((step) => step.action ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * The community's workflows, read from kind:30620 definition events and the
 * relay's run-history endpoint.
 *
 * What the browser can do here is bounded by the protocol, not by the client:
 * definitions, runs, traces, approvals and manual triggers are all reachable,
 * because each is either a signed event or an authenticated HTTP read that
 * needs no native host.
 */
export function WorkflowsPage() {
  const { canSign } = useAuth();
  const { workflows, channelNames, connected, loading } = useWorkflows();
  const { triggerWorkflow } = useWorkflowActions();
  const [viewerPubkey, setViewerPubkey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    void ownPubkey().then((pubkey) => {
      if (alive) setViewerPubkey(pubkey);
    });
    return () => {
      alive = false;
    };
  }, []);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () => workflows.filter((workflow) => matches(workflow, needle)),
    [workflows, needle],
  );
  const workflowIds = useMemo(
    () => workflows.map((workflow) => workflow.id),
    [workflows],
  );
  const lastRuns = useLatestRuns(workflowIds);

  if (!canSign) {
    return <LoginPage />;
  }

  return (
    <div
      className="mx-auto max-w-4xl space-y-4 p-4"
      data-testid="workflows-page"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <WorkflowIcon aria-hidden className="h-5 w-5" />
          Workflows
        </h1>
        <Input
          className="h-8 w-full max-w-56"
          placeholder="Filter workflows"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter workflows"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Workflow definitions are channel-scoped kind:30620 events; run history
        comes from the relay. Only a workflow&apos;s owner can start it by hand.
      </p>

      {!connected ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Connecting to the relay…
        </p>
      ) : loading && workflows.length === 0 ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Loading workflows…
        </p>
      ) : visible.length === 0 ? (
        <p
          className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground"
          data-testid="workflows-empty"
        >
          {workflows.length === 0
            ? "No workflows in the channels you can see."
            : "No workflow matches that filter."}
        </p>
      ) : (
        <div className="space-y-3" data-testid="workflows-list">
          {visible.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              channelName={
                workflow.channelId === null
                  ? null
                  : (channelNames.get(workflow.channelId) ?? null)
              }
              viewerPubkey={viewerPubkey}
              lastRunPage={lastRuns.get(workflow.id)}
              onTrigger={async (target) => {
                await triggerWorkflow(target.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
