/**
 * Reading workflow run history and step traces.
 *
 * Runs are NOT Nostr events. The kinds reserved for them (46001–46012 in
 * `crates/buzz-core/src/kind.rs`) are never emitted — `buzz-cli`'s own
 * `cmd_get_workflow_runs` says so in as many words: "The relay does not
 * currently emit workflow execution events (46001-46003). Run history is
 * stored in the workflow_runs DB table". The authoritative read is therefore
 * the relay's structured endpoint:
 *
 *   GET /workflows/{workflow_id}/runs?limit=N
 *     -> { runs: [...], next: { before, before_id } | null }
 *
 * routed at `crates/buzz-relay/src/router.rs` and serialized by `run_json` in
 * `crates/buzz-relay/src/api/workflows.rs`. Timestamps are unix seconds
 * (`.timestamp()`); `execution_trace` is the JSON array the executor
 * accumulates in `crates/buzz-workflow/src/executor.rs`, one entry per step.
 */

export type RunStatus = string;

export type TraceStep = {
  stepId: string;
  /**
   * A render key unique within the trace. Step ids are unique in a *valid*
   * definition, but a trace is data the client did not validate, so the key is
   * derived rather than assumed: repeats get a `#n` suffix.
   */
  key: string;
  status: string;
  /** The step's `output` object, rendered for display; empty when absent. */
  output: Record<string, unknown>;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  status: RunStatus;
  currentStep: number | null;
  trace: TraceStep[];
  startedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
};

export type WorkflowRunsPage = {
  runs: WorkflowRun[];
  /** Keyset cursor for the next page, or null when the history is exhausted. */
  next: { before: string; beforeId: string } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The executor writes `{step_id, status, output?}` per step and the run row
 * carries `started_at`/`completed_at` at the run level, so a trace entry's own
 * timing fields are frequently absent. Absent is reported as null rather than
 * as zero, which would render as a 1970 timestamp and a bogus duration.
 */
export function traceStepFromJson(value: unknown): TraceStep | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const stepId = asString(raw.step_id);
  if (stepId === null) return null;
  return {
    stepId,
    key: stepId,
    status: asString(raw.status) ?? "unknown",
    output: asRecord(raw.output) ?? {},
    startedAt: asNumber(raw.started_at),
    completedAt: asNumber(raw.completed_at),
    error: asString(raw.error),
  };
}

/** Disambiguate repeated step ids so each trace entry has its own render key. */
function withUniqueKeys(steps: TraceStep[]): TraceStep[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = seen.get(step.stepId) ?? 0;
    seen.set(step.stepId, occurrence + 1);
    return occurrence === 0
      ? step
      : { ...step, key: `${step.stepId}#${occurrence}` };
  });
}

/** Parse one row of the relay's `runs` array. Returns null for an unusable row. */
export function runFromJson(value: unknown): WorkflowRun | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const id = asString(raw.id);
  const workflowId = asString(raw.workflow_id);
  if (id === null || workflowId === null) return null;
  const trace = Array.isArray(raw.execution_trace)
    ? withUniqueKeys(
        raw.execution_trace
          .map(traceStepFromJson)
          .filter((step): step is TraceStep => step !== null),
      )
    : [];
  return {
    id,
    workflowId,
    status: asString(raw.status) ?? "unknown",
    currentStep: asNumber(raw.current_step),
    trace,
    startedAt: asNumber(raw.started_at),
    completedAt: asNumber(raw.completed_at),
    errorCode: asString(raw.error_code),
    errorMessage: asString(raw.error_message),
    createdAt: asNumber(raw.created_at) ?? 0,
  };
}

/** Parse a whole `GET /workflows/{id}/runs` response body. */
export function runsPageFromJson(body: unknown): WorkflowRunsPage {
  const raw = asRecord(body);
  const rows = raw !== null && Array.isArray(raw.runs) ? raw.runs : [];
  const runs = rows
    .map(runFromJson)
    .filter((run): run is WorkflowRun => run !== null);
  const cursor = asRecord(raw?.next);
  const before = asString(cursor?.before);
  const beforeId = asString(cursor?.before_id);
  return {
    runs,
    next: before !== null && beforeId !== null ? { before, beforeId } : null,
  };
}

/**
 * Run statuses the relay can still change under us.
 *
 * Mirrors `RunStatus` in `crates/buzz-db/src/workflow.rs`: a run is in flight
 * while it is pending, running, or parked on an approval.
 */
const ACTIVE_RUN_STATUSES = new Set(["pending", "running", "waiting_approval"]);

export function isActiveRun(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

export type StatusTone = "success" | "failure" | "active" | "waiting" | "muted";

/** Presentation tone for a run or step status. */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case "completed":
    case "succeeded":
      return "success";
    case "failed":
    case "error":
      return "failure";
    case "running":
    case "pending":
      return "active";
    case "waiting_approval":
      return "waiting";
    default:
      return "muted";
  }
}

/** `waiting_approval` -> `waiting approval`. */
export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * Elapsed time between two unix-second stamps, or null when either is missing.
 * Sub-second differences are reported in milliseconds so a fast step does not
 * flatten to "0s".
 */
export function formatDuration(
  startedAt: number | null,
  completedAt: number | null,
): string | null {
  if (startedAt === null || completedAt === null) return null;
  const seconds = completedAt - startedAt;
  if (seconds < 0) return null;
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The most recent run of a workflow.
 *
 * The relay orders its page by `created_at` descending (keyset pagination on
 * `(created_at, id)`), but the list is re-derived here rather than trusted:
 * the "last run" line is the one thing on the card a reader will take at face
 * value, and a page assembled from two fetches must not show an older run.
 */
export function latestRun(runs: WorkflowRun[]): WorkflowRun | null {
  let latest: WorkflowRun | null = null;
  for (const run of runs) {
    if (latest === null || run.createdAt > latest.createdAt) latest = run;
  }
  return latest;
}

/** Count of runs currently in flight, for the "running" affordance. */
export function activeRunCount(runs: WorkflowRun[]): number {
  return runs.filter((run) => isActiveRun(run.status)).length;
}
