import { useQueries, useQuery } from "@tanstack/react-query";

import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  approvalsFromJson,
  type WorkflowApproval,
} from "./lib/workflowApprovals.ts";
import {
  activeRunCount,
  runsPageFromJson,
  type WorkflowRunsPage,
} from "./lib/workflowRuns.ts";

/**
 * Run history and approvals come from the relay's structured HTTP reads rather
 * than from the execution events (kinds 46001–46012), which the relay does now
 * publish: those announce progress but carry no status, so an approval's
 * granted/denied/expired state and a run's terminal status are only readable
 * from the rows. The endpoints are NIP-98 authenticated GETs
 * (`authorize_workflow_read` in `crates/buzz-relay/src/api/workflows.rs`), which
 * a browser can sign with the same signer it uses for everything else — the
 * signed `u` tag must be the full URL including the query string, because the
 * relay rebuilds its expected URL from path *and* raw query.
 */

const DEFAULT_LIMIT = 20;

/** While a run is in flight the relay's row changes under us; poll for it. */
const ACTIVE_POLL_MS = 2_000;

function base(): string {
  return relayHttpBaseUrl().replace(/\/+$/, "");
}

async function authorizedGet(url: string): Promise<unknown> {
  const authorization = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, { headers: { authorization } });
  if (!response.ok) {
    // The relay's own reasons are client-safe here ("workflow not found",
    // "workflow is not accessible"), and far more useful than a bare code.
    let detail = "";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string") detail = ` — ${body.error}`;
    } catch {
      // Non-JSON body; the status alone will have to do.
    }
    throw new Error(`Relay refused the request (${response.status})${detail}`);
  }
  return response.json();
}

export const workflowRunsQueryKey = (workflowId: string) =>
  ["workflow-runs", workflowId] as const;

/**
 * `GET /workflows/{id}/runs?limit=N`.
 *
 * Enabled only when a workflow is actually open — every call costs a signature
 * and a round trip, so the list view does not fan out across every workflow.
 */
export function useWorkflowRuns(
  workflowId: string | null,
  options?: { limit?: number },
) {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  return useQuery<WorkflowRunsPage>({
    enabled: workflowId !== null,
    queryKey: [...workflowRunsQueryKey(workflowId ?? ""), limit],
    retry: false,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const page = query.state.data;
      return page !== undefined && activeRunCount(page.runs) > 0
        ? ACTIVE_POLL_MS
        : false;
    },
    queryFn: async () => {
      const url = `${base()}/workflows/${workflowId}/runs?limit=${limit}`;
      return runsPageFromJson(await authorizedGet(url));
    },
  });
}

/**
 * The most recent run of each of several workflows, for the list view.
 *
 * There is no bulk run endpoint — `/workflows/{id}/runs` is per workflow — so
 * this costs one signed request per workflow. `limit=1` keeps each response to
 * a single row, and the results share the same query cache as the detail view's
 * fetch, so opening a workflow does not re-sign what the list already holds.
 * Buzz Desktop shows last-run only inside its detail panel and therefore never
 * pays this; a list-level last-run is the deliberate difference.
 */
export function useLatestRuns(
  workflowIds: string[],
): Map<string, WorkflowRunsPage> {
  const results = useQueries({
    queries: workflowIds.map((workflowId) => ({
      queryKey: [...workflowRunsQueryKey(workflowId), 1],
      retry: false,
      staleTime: 15_000,
      queryFn: async (): Promise<WorkflowRunsPage> => {
        const url = `${base()}/workflows/${workflowId}/runs?limit=1`;
        return runsPageFromJson(await authorizedGet(url));
      },
    })),
  });
  const pages = new Map<string, WorkflowRunsPage>();
  results.forEach((result, index) => {
    if (result.data !== undefined) pages.set(workflowIds[index], result.data);
  });
  return pages;
}

export const runApprovalsQueryKey = (workflowId: string, runId: string) =>
  ["workflow-run-approvals", workflowId, runId] as const;

/** `GET /workflows/{workflow_id}/runs/{run_id}/approvals`. */
export function useRunApprovals(
  workflowId: string | null,
  runId: string | null,
  enabled: boolean,
) {
  return useQuery<WorkflowApproval[]>({
    enabled: enabled && workflowId !== null && runId !== null,
    queryKey: runApprovalsQueryKey(workflowId ?? "", runId ?? ""),
    retry: false,
    staleTime: 5_000,
    queryFn: async () => {
      const url = `${base()}/workflows/${workflowId}/runs/${runId}/approvals`;
      return approvalsFromJson(await authorizedGet(url));
    },
  });
}
