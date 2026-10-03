/**
 * Done today from both sources (web redesign Phase 8):
 *
 *   30624 terminal heads  member-readable — every agent in the viewer's
 *                         channels, with the turn's title when it set one.
 *   44200 turn metrics    owner-only and encrypted — the viewer's own agents,
 *                         including heartbeat turns, which publish no 30624.
 *
 * One row per turn, keyed by (agent, turn id): a turn both sources report is
 * listed once, carrying the metric's stop reason and the status title. A
 * terminal head that is not `done` (error, cancelled, a harness restart) is an
 * abnormal ending and says so, like a non-`end_turn` stop reason.
 */

import type { StatusJob, StatusTurn } from "./taskStatus.ts";
import type { DoneRow, DoneSummary, WorkScope } from "./workTypes.ts";

/** What a 30624 terminal state says about how the turn ended. */
export function statusEnding(turn: Pick<StatusTurn, "state" | "reason">) {
  if (turn.state === "done" || turn.state === "running") {
    return null;
  }
  return turn.reason ? `${turn.state} · ${turn.reason}` : turn.state;
}

/** Ordinary completion is quiet; a lost heartbeat is stated explicitly. */
export function jobEnding(job: Pick<StatusJob, "state" | "reason">) {
  return job.state === "dropped"
    ? "dropped · no heartbeat"
    : statusEnding({ ...job, state: job.state });
}

function abnormal(stopReason: string | null): boolean {
  return stopReason !== null && stopReason !== "end_turn";
}

/**
 * Merge a metrics summary (or null when metrics are not readable) with the
 * status turns that ended since `sinceS`, scoped like every Work section.
 */
export function mergeDone(
  metrics: DoneSummary | null,
  ended: readonly StatusTurn[],
  sinceS: number,
  scope: WorkScope = "everywhere",
  channelId: string | null = null,
  jobs: readonly StatusJob[] = [],
): DoneSummary {
  const byTurn = new Map<string, DoneRow>();
  for (const row of metrics?.rows ?? []) {
    byTurn.set(`${row.agentPubkey}:${row.key}`, {
      ...row,
      key: `${row.agentPubkey}:${row.key}`,
    });
  }
  for (const turn of ended) {
    const at = turn.ended ?? turn.beatAt;
    if (at < sinceS) {
      continue;
    }
    if (scope === "channel" && channelId && turn.channelId !== channelId) {
      continue;
    }
    const key = `${turn.agentPubkey}:${turn.turnId}`;
    const previous = byTurn.get(key);
    const ending = statusEnding(turn);
    if (previous) {
      byTurn.set(key, {
        ...previous,
        title: previous.title ?? turn.title,
        triggerId: previous.triggerId ?? turn.trigger,
        startedAt: turn.started,
        endedAt: turn.ended,
        stopReason: abnormal(previous.stopReason)
          ? previous.stopReason
          : (ending ?? previous.stopReason),
      });
      continue;
    }
    byTurn.set(key, {
      key,
      agentPubkey: turn.agentPubkey,
      channelId: turn.channelId,
      at,
      startedAt: turn.started,
      endedAt: turn.ended,
      stopReason: ending,
      title: turn.title,
      triggerId: turn.trigger,
    });
  }
  for (const job of jobs) {
    const at = job.ended ?? job.beatAt;
    if (
      at < sinceS ||
      (scope === "channel" && channelId && job.channelId !== channelId)
    )
      continue;
    const key = `job:${job.agentPubkey}:${job.channelId}:${job.jobId}`;
    byTurn.set(key, {
      key,
      agentPubkey: job.agentPubkey,
      channelId: job.channelId,
      at,
      startedAt: job.started,
      endedAt: job.ended,
      title: job.title,
      triggerId: job.trigger,
      job: { id: job.jobId, role: job.role, engine: job.engine },
      stopReason: jobEnding(job),
    });
  }
  const rows = [...byTurn.values()].sort(
    (a, b) => b.at - a.at || a.key.localeCompare(b.key),
  );
  return {
    state: "ready",
    count: rows.length,
    locked: metrics?.locked ?? 0,
    last: rows[0] ?? null,
    rows,
  };
}
