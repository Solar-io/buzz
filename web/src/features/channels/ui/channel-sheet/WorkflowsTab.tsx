import { useEffect, useState } from "react";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { useWorkflows } from "@/features/workflows/useWorkflows";
import { useLatestRuns } from "@/features/workflows/useWorkflowRuns";
import {
  triggerDescription,
  type WorkflowSummary,
} from "@/features/workflows/lib/workflowDefinition.ts";
import { latestRun } from "@/features/workflows/lib/workflowRuns.ts";
import {
  NEW_WORKFLOW_YAML,
  workflowEventTemplate,
} from "@/features/workflows/lib/workflowPublish.ts";
import { WorkflowEditor } from "@/features/workflows/ui/WorkflowEditor";
import { WorkflowStatusBadge } from "@/features/workflows/ui/WorkflowStatusBadge";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey, signNostrEvent } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";

type Props = {
  channelId: string;
  writable: boolean;
  onBusyChange: (busy: boolean) => void;
};

/** The active channel's definitions; edit authority belongs to each author. */
export function WorkflowsTab({ channelId, writable, onBusyChange }: Props) {
  const { canSign } = useAuth();
  const { session } = useRelaySession();
  const { workflows, connected, loading } = useWorkflows();
  const visible = workflows.filter(
    (workflow) => workflow.channelId === channelId,
  );
  const runs = useLatestRuns(
    connected ? visible.map((workflow) => workflow.id) : [],
  );
  const [viewer, setViewer] = useState<string | null>(null);
  const [editor, setEditor] = useState<WorkflowSummary | "new" | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const enabled = writable && canSign && connected && viewer !== null;
  useEffect(() => {
    let alive = true;
    void ownPubkey()
      .then((pubkey) => {
        if (alive) setViewer(pubkey);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (editor !== null)
    return (
      <div className="py-5">
        <WorkflowEditor
          initialYaml={editor === "new" ? NEW_WORKFLOW_YAML : editor.yaml}
          editing={editor !== "new"}
          disabled={!enabled}
          onBusyChange={onBusyChange}
          onCancel={() => setEditor(null)}
          onSave={async (yaml) => {
            const existing = editor === "new" ? undefined : editor;
            const event = await signNostrEvent(
              workflowEventTemplate(channelId, yaml, existing),
            );
            const result = await session.publish(event);
            if (!result.ok) throw new Error(result.message);
            setReceipt("Workflow saved.");
            setEditor(null);
          }}
        />
      </div>
    );

  return (
    <div className="space-y-4 py-5" data-testid="channel-workflows">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Workflows</h2>
        <Button
          className="min-h-11"
          variant="outline"
          disabled={!enabled}
          onClick={() => {
            setReceipt(null);
            setEditor("new");
          }}
        >
          New workflow
        </Button>
      </div>
      {!connected && (
        <p className="text-sm text-muted-foreground">
          Connect to the relay to save workflows.
        </p>
      )}
      {receipt !== null && (
        <p role="status" className="text-sm text-leaf-ink">
          {receipt}
        </p>
      )}
      {loading && visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading workflows…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
          No workflows in this channel yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((workflow) => {
            const page = runs.get(workflow.id);
            const run = page === undefined ? null : latestRun(page.runs);
            return (
              <li
                key={workflow.id}
                className="space-y-2 rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 break-words text-sm font-semibold">
                    {workflow.name}
                  </h3>
                  {viewer === workflow.ownerPubkey && (
                    <Button
                      variant="outline"
                      className="min-h-11 shrink-0"
                      disabled={!enabled}
                      aria-label={`Edit ${workflow.name}`}
                      onClick={() => {
                        setReceipt(null);
                        setEditor(workflow);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
                <p className="break-words text-sm text-muted-foreground">
                  {triggerDescription(workflow.trigger)}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  <span>{workflow.enabled ? "Enabled" : "Disabled"}</span>
                  {run !== null ? (
                    <WorkflowStatusBadge status={run.status} />
                  ) : (
                    <span>
                      {page === undefined
                        ? "Run status not loaded"
                        : "No runs yet"}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
