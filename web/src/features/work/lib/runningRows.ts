/**
 * Running rows from both lifecycle sources (web redesign Phase 8).
 *
 *   30624 status   member-readable, one head per (agent, channel), refreshed
 *                  every 60 s; carries the title and progress.
 *   observer 24200 owner-only, a frame every 10 s; the only source for a
 *                  heartbeat turn (no channel, so no 30624) and for an agent
 *                  whose harness predates 30624.
 *
 * Both name the same turn id (`buzz-acp` pool.rs builds the observer context
 * and the status publisher from one `turn_id`), so a turn seen by both is ONE
 * row keyed `turn:<agent>:<turn>` — a refresh, a detail update or a second
 * source mutates that row in place and never adds another.
 *
 * Honesty (VISION_ACTIVITY): a running head that stops refreshing is not
 * hidden. It reads "no heartbeat" after {@link STATUS_STALE_S} and "lost"
 * after {@link LOST_AFTER_S}, exactly as a silent observer turn does, until
 * the harness says it ended or the viewer dismisses it.
 */

import {
  type ActiveTurn,
  HISTORY_HORIZON_S,
  LIVENESS_BUDGET_S,
  LOST_AFTER_S,
} from "./activeTurns.ts";
import {
  currentTurns,
  detailFor,
  hasEnded,
  STATUS_STALE_S,
  type StatusStore,
  type StatusTurn,
} from "./taskStatus.ts";
import type { RunRow, RunRowState } from "./workTypes.ts";

const STATE_RANK: Record<RunRowState, number> = {
  live: 0,
  stalled: 1,
  lost: 2,
  reacting: 3,
};

/** `agent|channel` — the (agent, channel) a turn and a 💬 reaction share. */
export function slotOf(agentPubkey: string, channelId: string | null): string {
  return `${agentPubkey}|${channelId ?? ""}`;
}

function silentState(silentS: number): RunRowState {
  return silentS > LOST_AFTER_S ? "lost" : "stalled";
}

export interface LifecycleRows {
  /** Live first, then stalled, then lost; newest start first within each. */
  rows: RunRow[];
  /**
   * The newest word either lifecycle source has on each (agent, channel):
   * a 💬 reaction no newer than this is already accounted for.
   */
  spokenFor: Map<string, number>;
}

/**
 * Merge observer turns (already reduced by `activeTurns`) with the status
 * store. Per (agent, channel):
 *
 * - The harness said the observed turn ended (a terminal 30624 for that turn
 *   id): no row — even when the observer buffer lost `turn_completed`.
 * - A status head names a NEWER turn than the observed one: the observed turn
 *   is over (one turn per channel per agent); the status turn stands.
 * - Same turn in both: one row. It is live while EITHER source is fresh (the
 *   status refresh runs even with `BUZZ_ACP_TURN_LIVENESS_SECS=0`), and its
 *   title and progress come from the turn's own detail.
 * - Status only: its own row, aged by the head's `created_at`.
 * - Observer only: the observer row as before, plus a detail if one exists.
 */
export function lifecycleRows(
  observed: readonly ActiveTurn[],
  store: StatusStore,
  nowS: number,
  dismissed: ReadonlySet<string> = new Set(),
): LifecycleRows {
  const status = new Map<string, StatusTurn>();
  const spokenFor = new Map<string, number>();
  for (const turn of currentTurns(store)) {
    const slot = slotOf(turn.agentPubkey, turn.channelId);
    status.set(slot, turn);
    spokenFor.set(slot, turn.beatAt);
  }
  const rows: RunRow[] = [];
  const taken = new Set<string>();

  for (const turn of observed) {
    const slot = slotOf(turn.agentPubkey, turn.channelId);
    const head = turn.channelId ? status.get(slot) : undefined;
    if (
      turn.channelId &&
      hasEnded(store, turn.agentPubkey, turn.channelId, turn.turnId)
    ) {
      // Not `taken`: a newer turn in the same channel may still be running.
      continue;
    }
    if (head && head.turnId !== turn.turnId && head.started > turn.startedAt) {
      // Superseded by a newer turn the status head knows about; that turn
      // gets its own row below.
      continue;
    }
    taken.add(slot);
    spokenFor.set(slot, Math.max(spokenFor.get(slot) ?? 0, turn.lastBeatAt));
    const detail = turn.channelId
      ? detailFor(store, turn.agentPubkey, turn.channelId, turn.turnId)
      : null;
    let state: RunRowState = turn.state;
    let lastBeatAt = turn.lastBeatAt;
    if (head && head.turnId === turn.turnId && head.state === "running") {
      lastBeatAt = Math.max(lastBeatAt, head.beatAt);
      const observerSilent = nowS - turn.lastBeatAt;
      const statusSilent = nowS - head.beatAt;
      state =
        observerSilent <= LIVENESS_BUDGET_S || statusSilent <= STATUS_STALE_S
          ? "live"
          : silentState(Math.min(observerSilent, statusSilent));
    }
    rows.push({
      key: `turn:${turn.agentPubkey}:${turn.turnId}`,
      agentPubkey: turn.agentPubkey,
      turnId: turn.turnId,
      channelId: turn.channelId,
      startedAt: turn.startedAt,
      lastBeatAt,
      state,
      source: "observer",
      title: detail?.title ?? null,
      progress: detail?.progress ?? null,
      triggerId:
        (head?.turnId === turn.turnId ? head.trigger : null) ??
        turn.triggeringEventIds[0] ??
        null,
    });
  }

  for (const [slot, head] of status) {
    if (
      taken.has(slot) ||
      head.state !== "running" ||
      dismissed.has(head.turnId)
    ) {
      continue;
    }
    const silent = nowS - head.beatAt;
    if (silent > HISTORY_HORIZON_S) {
      continue;
    }
    rows.push({
      key: `turn:${head.agentPubkey}:${head.turnId}`,
      agentPubkey: head.agentPubkey,
      turnId: head.turnId,
      channelId: head.channelId,
      startedAt: head.started,
      lastBeatAt: head.beatAt,
      state: silent <= STATUS_STALE_S ? "live" : silentState(silent),
      source: "status",
      title: head.title,
      progress: head.progress,
      triggerId: head.trigger,
    });
  }

  rows.sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
      a.key.localeCompare(b.key),
  );
  return { rows, spokenFor };
}
