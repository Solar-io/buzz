/**
 * Running turns from observer frames (phase-1 §2.4).
 *
 * `agentWorkingState` (agents/lib/observerEvents.ts) answers "working" with
 * `false` after 180 s of silence — it HIDES a stalled turn, which
 * VISION_ACTIVITY forbids ("never go dark", "honesty over guessing"). This
 * reducer keeps every started turn on screen until the harness says it
 * ended, and labels silence instead of hiding it. It ports the semantics of
 * desktop `activeAgentTurnsStore.ts` (turn_liveness is the floor that keeps a
 * quiet turn alive; 2.5 × the 10 s liveness interval is the budget) as a pure
 * function over the frames the ObserverProvider already decrypts.
 *
 * Owner-only: kind 24200 is encrypted to the agent's owner, so these rows are
 * the viewer's own agents. Reaction rows (queuedReactions.ts) cover the rest.
 */

import type { ObserverFrame } from "@/features/agents/lib/observerEvents";

/**
 * Seconds of silence before a turn reads as stalled: 2.5 × the harness's
 * `BUZZ_ACP_TURN_LIVENESS_SECS` default of 10 s (desktop REMOVE_AFTER_MS).
 */
export const LIVENESS_BUDGET_S = 25;
/** Past this the row reads "lost · last seen …" instead of "no heartbeat". */
export const LOST_AFTER_S = 600;
/**
 * A turn silent this long is history, not a running claim: the frame buffer
 * keeps `turn_started` through its cap but can evict `turn_completed`, so an
 * old turn loaded by an agent's history REQ would otherwise read "lost"
 * forever. An hour of "lost" is the honest window; past it the row goes.
 */
export const HISTORY_HORIZON_S = 3_600;

export type RunState = "live" | "stalled" | "lost";

export interface ActiveTurn {
  agentPubkey: string;
  turnId: string;
  channelId: string | null;
  startedAt: number;
  lastBeatAt: number;
  state: RunState;
  /** Event ids that started the turn (turn_started payload). */
  triggeringEventIds: string[];
}

const TERMINAL_KINDS = new Set(["turn_completed", "turn_error"]);

function rfc3339Seconds(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** `turn_started.payload.triggeringEventIds`, defensively. */
export function frameTriggers(frame: ObserverFrame): string[] {
  const payload = frame.payload as { triggeringEventIds?: unknown } | null;
  const ids = payload?.triggeringEventIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
}

interface Draft {
  turnId: string;
  channelId: string | null;
  payloadStart: number | null;
  earliest: number;
  lastBeat: number;
  ended: boolean;
  triggers: Set<string>;
}

/** Live-first, then stalled, then lost; newest start first within each. */
const STATE_RANK: Record<RunState, number> = { live: 0, stalled: 1, lost: 2 };

/**
 * Every turn that started and has not ended, per agent.
 *
 * - Frames group by `(agent, turnId)`; frames with no `turnId` are ignored,
 *   except `agent_panic`, which ends every turn of that agent whose last
 *   frame is not newer than the panic.
 * - `turn_completed` / `turn_error` end their own turn.
 * - `startedAt` is the newest parseable `frame.startedAt` (the harness stamps
 *   it on every frame, so it survives a reload after `turn_started` fell out
 *   of the live lookback), else the earliest frame's `createdAt`.
 * - `lastBeatAt` is the newest frame of the turn — `turn_liveness` counts
 *   like any other frame, which is what keeps a quiet turn alive.
 */
export function activeTurns(
  byAgent: ReadonlyMap<string, readonly ObserverFrame[]>,
  nowS: number,
  dismissed: ReadonlySet<string> = new Set(),
): ActiveTurn[] {
  const out: ActiveTurn[] = [];
  for (const [agentPubkey, frames] of byAgent) {
    const turns = new Map<string, Draft>();
    let panicAt: number | null = null;
    for (const frame of frames) {
      if (frame.kind === "agent_panic") {
        panicAt = Math.max(panicAt ?? 0, frame.createdAt);
      }
      if (!frame.turnId) {
        continue;
      }
      let draft = turns.get(frame.turnId);
      if (!draft) {
        draft = {
          turnId: frame.turnId,
          channelId: null,
          payloadStart: null,
          earliest: frame.createdAt,
          lastBeat: frame.createdAt,
          ended: false,
          triggers: new Set(),
        };
        turns.set(frame.turnId, draft);
      }
      draft.channelId = draft.channelId ?? frame.channelId;
      draft.earliest = Math.min(draft.earliest, frame.createdAt);
      draft.lastBeat = Math.max(draft.lastBeat, frame.createdAt);
      const started = rfc3339Seconds(frame.startedAt);
      if (started !== null && started > (draft.payloadStart ?? 0)) {
        draft.payloadStart = started;
      }
      if (TERMINAL_KINDS.has(frame.kind)) {
        draft.ended = true;
      }
      if (frame.kind === "turn_started") {
        for (const id of frameTriggers(frame)) {
          draft.triggers.add(id);
        }
      }
    }
    for (const draft of turns.values()) {
      if (draft.ended || dismissed.has(draft.turnId)) {
        continue;
      }
      if (panicAt !== null && panicAt >= draft.lastBeat) {
        continue;
      }
      const silent = nowS - draft.lastBeat;
      if (silent > HISTORY_HORIZON_S) {
        continue;
      }
      out.push({
        agentPubkey,
        turnId: draft.turnId,
        channelId: draft.channelId,
        startedAt: draft.payloadStart ?? draft.earliest,
        lastBeatAt: draft.lastBeat,
        state:
          silent > LOST_AFTER_S
            ? "lost"
            : silent > LIVENESS_BUDGET_S
              ? "stalled"
              : "live",
        triggeringEventIds: [...draft.triggers],
      });
    }
  }
  return out.sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      b.startedAt - a.startedAt ||
      a.turnId.localeCompare(b.turnId),
  );
}

/**
 * Every event id any observed turn (running OR finished) was started by, per
 * agent — the queued rule's "has this trigger already been picked up".
 */
export function observedTriggers(
  byAgent: ReadonlyMap<string, readonly ObserverFrame[]>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [agent, frames] of byAgent) {
    for (const frame of frames) {
      if (frame.kind !== "turn_started") {
        continue;
      }
      const ids = frameTriggers(frame);
      if (ids.length === 0) {
        continue;
      }
      const set = out.get(agent) ?? new Set<string>();
      for (const id of ids) {
        set.add(id);
      }
      out.set(agent, set);
    }
  }
  return out;
}
