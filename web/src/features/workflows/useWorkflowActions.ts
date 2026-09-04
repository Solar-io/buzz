import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { approvalEventTemplate } from "./lib/workflowApprovals.ts";
import {
  runIdFromRelayMessage,
  triggerEventTemplate,
} from "./lib/workflowTrigger.ts";
import { workflowRunsQueryKey } from "./useWorkflowRuns.ts";

/**
 * Workflow writes. Both are ordinary signed events over the existing relay
 * session — nothing here needs a native host.
 *
 * - Trigger: kind 46020, `d` = workflow uuid. The relay answers with
 *   `response:{"run_id": ...}` on the OK message.
 * - Approve / deny: kind 46030 / 46031, `d` = the approval's `approval_ref`.
 */
export function useWorkflowActions() {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();

  const publish = useCallback(
    async (template: {
      kind: number;
      tags: string[][];
      content: string;
    }): Promise<string> => {
      const event = await signNostrEvent(template);
      const result = await session.publish(event);
      if (!result.ok) {
        // The relay's rejection text is client-safe by contract and says which
        // precondition failed ("forbidden: workflow is disabled or inactive"),
        // which is the whole value of surfacing it rather than a generic error.
        throw new Error(result.message || "The relay rejected the request.");
      }
      return result.message;
    },
    [session],
  );

  /** Start a run by hand. Resolves to the new run id when the relay reports one. */
  const triggerWorkflow = useCallback(
    async (workflowId: string): Promise<string | null> => {
      const message = await publish(triggerEventTemplate(workflowId));
      await queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === workflowRunsQueryKey(workflowId)[0] &&
          query.queryKey[1] === workflowId,
      });
      return runIdFromRelayMessage(message);
    },
    [publish, queryClient],
  );

  /** Grant or deny a pending approval by its `approval_ref`. */
  const decideApproval = useCallback(
    async (
      approvalRef: string,
      approved: boolean,
      note?: string,
    ): Promise<void> => {
      await publish(approvalEventTemplate(approvalRef, approved, note));
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "workflow-run-approvals",
      });
    },
    [publish, queryClient],
  );

  return { triggerWorkflow, decideApproval };
}
