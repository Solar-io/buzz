import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeRunCount,
  formatDuration,
  isActiveRun,
  latestRun,
  runFromJson,
  runsPageFromJson,
  statusLabel,
  statusTone,
  traceStepFromJson,
} from "./workflowRuns.ts";

const WORKFLOW_ID = "4f1c8b6a-2d31-4a55-9c0e-7b8d5e2f1a90";

/**
 * The body below is shaped exactly as `run_json` in
 * `crates/buzz-relay/src/api/workflows.rs` writes it: snake_case keys, unix
 * seconds for every timestamp, `execution_trace` verbatim from the executor.
 */
function relayBody() {
  return {
    runs: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        workflow_id: WORKFLOW_ID,
        status: "completed",
        current_step: 2,
        execution_trace: [
          {
            step_id: "notify",
            status: "completed",
            output: { event_id: "beef", channel: "general" },
            started_at: 1_700_000_000,
            completed_at: 1_700_000_002,
          },
          { step_id: "quiet_hours", status: "skipped" },
        ],
        started_at: 1_700_000_000,
        completed_at: 1_700_000_004,
        error_code: null,
        error_message: null,
        created_at: 1_700_000_000,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        workflow_id: WORKFLOW_ID,
        status: "failed",
        current_step: 0,
        execution_trace: [
          {
            step_id: "call_out",
            status: "failed",
            error: "webhook returned 500",
          },
        ],
        started_at: 1_699_999_000,
        completed_at: 1_699_999_030,
        error_code: "webhook_error",
        error_message: "webhook returned 500",
        created_at: 1_699_999_000,
      },
    ],
    next: {
      before: "2026-08-01T12:00:00Z",
      before_id: "22222222-2222-4222-8222-222222222222",
    },
  };
}

test("parses the relay's runs page, trace included", () => {
  const page = runsPageFromJson(relayBody());
  assert.equal(page.runs.length, 2);
  const [first] = page.runs;
  assert.equal(first.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(first.workflowId, WORKFLOW_ID);
  assert.equal(first.status, "completed");
  assert.equal(first.currentStep, 2);
  assert.equal(first.trace.length, 2);
  assert.equal(first.trace[0].stepId, "notify");
  assert.deepEqual(first.trace[0].output, {
    event_id: "beef",
    channel: "general",
  });
  assert.equal(first.trace[1].status, "skipped");
  assert.equal(first.startedAt, 1_700_000_000);
  assert.equal(first.completedAt, 1_700_000_004);
});

test("carries a failed run's error code and message", () => {
  const page = runsPageFromJson(relayBody());
  const failed = page.runs[1];
  assert.equal(failed.errorCode, "webhook_error");
  assert.equal(failed.errorMessage, "webhook returned 500");
  assert.equal(failed.trace[0].error, "webhook returned 500");
});

test("reads the keyset cursor, and reports its absence as exhausted", () => {
  assert.deepEqual(runsPageFromJson(relayBody()).next, {
    before: "2026-08-01T12:00:00Z",
    beforeId: "22222222-2222-4222-8222-222222222222",
  });
  const body = relayBody();
  body.next = null;
  assert.equal(runsPageFromJson(body).next, null);
});

test("a trace entry with no timings reports null, never zero", () => {
  // The executor writes {step_id, status, output} with no timings, so a naive
  // `?? 0` would render 1970 and a nonsense duration.
  const step = traceStepFromJson({ step_id: "quiet_hours", status: "skipped" });
  assert.equal(step.startedAt, null);
  assert.equal(step.completedAt, null);
  assert.deepEqual(step.output, {});
  assert.equal(formatDuration(step.startedAt, step.completedAt), null);
});

test("drops rows the relay could not have produced instead of rendering blanks", () => {
  assert.equal(runFromJson({ status: "completed" }), null, "no id");
  assert.equal(runFromJson(null), null);
  assert.equal(traceStepFromJson({ status: "completed" }), null, "no step_id");
  assert.deepEqual(runsPageFromJson({}).runs, []);
  assert.deepEqual(runsPageFromJson(null).runs, []);
});

test("keeps a non-array execution_trace from breaking the run", () => {
  const run = runFromJson({
    id: "x",
    workflow_id: WORKFLOW_ID,
    status: "running",
    execution_trace: "not an array",
    created_at: 1,
  });
  assert.deepEqual(run.trace, []);
});

test("gives repeated trace step ids distinct render keys", () => {
  const run = runFromJson({
    id: "r1",
    workflow_id: WORKFLOW_ID,
    status: "completed",
    execution_trace: [
      { step_id: "retry", status: "failed" },
      { step_id: "retry", status: "completed" },
    ],
    created_at: 1,
  });
  assert.equal(run.trace[0].key, "retry");
  assert.equal(run.trace[1].key, "retry#1");
  assert.equal(run.trace[1].stepId, "retry", "the step id itself is unchanged");
});

test("classifies the relay's own RunStatus values as active or settled", () => {
  // crates/buzz-db/src/workflow.rs — RunStatus, serialized snake_case.
  assert.equal(isActiveRun("pending"), true);
  assert.equal(isActiveRun("running"), true);
  assert.equal(isActiveRun("waiting_approval"), true);
  assert.equal(isActiveRun("completed"), false);
  assert.equal(isActiveRun("failed"), false);
  assert.equal(isActiveRun("cancelled"), false);
});

test("gives each status a distinct tone", () => {
  assert.equal(statusTone("completed"), "success");
  assert.equal(statusTone("failed"), "failure");
  assert.equal(statusTone("running"), "active");
  assert.equal(statusTone("pending"), "active");
  assert.equal(statusTone("waiting_approval"), "waiting");
  assert.equal(statusTone("cancelled"), "muted");
  assert.equal(statusTone("skipped"), "muted");
  assert.equal(statusLabel("waiting_approval"), "waiting approval");
});

test("formats durations across the units it switches between", () => {
  assert.equal(formatDuration(100, 100.25), "250ms");
  assert.equal(formatDuration(100, 102), "2.0s");
  assert.equal(formatDuration(100, 190), "1m 30s");
  assert.equal(formatDuration(0, 3_930), "1h 5m");
  assert.equal(formatDuration(null, 5), null);
  assert.equal(formatDuration(5, null), null);
  assert.equal(
    formatDuration(10, 5),
    null,
    "a negative span is not a duration",
  );
});

test("picks the newest run regardless of the order rows arrive in", () => {
  const page = runsPageFromJson(relayBody());
  assert.equal(latestRun(page.runs).id, "11111111-1111-4111-8111-111111111111");
  const reversed = [...page.runs].reverse();
  assert.equal(latestRun(reversed).id, "11111111-1111-4111-8111-111111111111");
  assert.equal(latestRun([]), null);
});

test("counts only the runs still in flight", () => {
  const page = runsPageFromJson(relayBody());
  assert.equal(activeRunCount(page.runs), 0);
  page.runs[0].status = "waiting_approval";
  assert.equal(activeRunCount(page.runs), 1);
});
