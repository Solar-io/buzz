/**
 * The single join behind the Work tab (phase-1 §2): needs, running, queued
 * and done from their families of inputs, scoped once. Pure — the provider
 * and the hook gather inputs, the UI renders the result.
 */

import type { ObserverFrame } from "@/features/agents/lib/observerEvents";
import { activeTurns, observedTriggers } from "./activeTurns.ts";
import { mergeDone } from "./doneToday.ts";
import { buildNeeds, type NeedInputs, scopedNeeds } from "./needsYou.ts";
import { type ReactionEvent, reactionWork } from "./queuedReactions.ts";
import { lifecycleRows, slotOf } from "./runningRows.ts";
import { endedTurns, type StatusStore, statusTriggers } from "./taskStatus.ts";
import { type MetricEntry, summarizeDone } from "./turnMetrics.ts";
import type {
  DoneState,
  QueuedRow,
  RunRow,
  WorkFeed,
  WorkScope,
} from "./workTypes.ts";

/** A reacted-to event, fetched lazily so its channel is known. */
export interface ReactionTarget {
  channelId: string;
}

/**
 * 30624 task status, `#h`-scoped to the viewer's channels (Phase 8). `state`
 * is whether the history REQ has settled; `sinceS` is local midnight.
 */
export interface StatusInput {
  state: "loading" | "ready" | "unavailable";
  store: StatusStore;
  sinceS: number;
}

export interface WorkInputs {
  needs: NeedInputs;
  /** `useObserverStore().byAgent` — the viewer's own agents' frames. */
  observer: ReadonlyMap<string, readonly ObserverFrame[]>;
  /** Locally dismissed turn ids (cleared on reload). */
  dismissedTurns: ReadonlySet<string>;
  /** Kind 7 + kind 5 from known agents, `#h`-scoped. */
  reactions: readonly ReactionEvent[];
  /** Reacted-to event id → its channel, once fetched. */
  targets: ReadonlyMap<string, ReactionTarget>;
  /** Decrypted 44200 entries, or why there are none. */
  metrics:
    | { state: "ready"; entries: readonly MetricEntry[]; sinceS: number }
    | { state: "loading" | "locked" | "unavailable" };
  /** Kind-30624 heads. Rows read the store even before it is `ready`. */
  status: StatusInput;
}

function inScope(
  channelId: string | null,
  scope: WorkScope,
  openChannelId: string | null,
): boolean {
  if (scope !== "channel" || !openChannelId) {
    return true;
  }
  return channelId !== null && channelId === openChannelId;
}

/** Union of two per-agent trigger maps. */
function mergeTriggers(
  a: Map<string, Set<string>>,
  b: Map<string, Set<string>>,
): Map<string, Set<string>> {
  for (const [agent, ids] of b) {
    const set = a.get(agent) ?? new Set<string>();
    for (const id of ids) {
      set.add(id);
    }
    a.set(agent, set);
  }
  return a;
}

/**
 * Done today: ready as soon as EITHER source is (each covers turns the other
 * cannot); with neither, the metrics' reason (locked / unavailable) once the
 * status REQ has settled, else still loading — never a "0" nobody measured.
 */
function doneState(inputs: WorkInputs, scope: WorkScope, open: string | null) {
  const { metrics, status } = inputs;
  const statusReady = status.state === "ready";
  if (metrics.state !== "ready" && !statusReady) {
    if (status.state === "loading" || metrics.state === "loading") {
      return { state: "loading" } as const;
    }
    return { state: metrics.state };
  }
  const metricRows =
    metrics.state === "ready"
      ? summarizeDone(metrics.entries, metrics.sinceS, scope, open)
      : null;
  const sinceS = metrics.state === "ready" ? metrics.sinceS : status.sinceS;
  return mergeDone(
    metricRows,
    statusReady ? endedTurns(status.store, sinceS) : [],
    sinceS,
    scope,
    open,
  );
}

export function buildWorkFeed(
  inputs: WorkInputs,
  nowS: number,
  scope: WorkScope,
  openChannelId: string | null,
): WorkFeed {
  const { needs, counts } = scopedNeeds(
    buildNeeds(inputs.needs, nowS),
    scope,
    openChannelId,
    nowS,
  );

  const store = inputs.status.store;
  const { rows: lifecycle, spokenFor } = lifecycleRows(
    activeTurns(inputs.observer, nowS, inputs.dismissedTurns),
    store,
    nowS,
    inputs.dismissedTurns,
  );
  const observedAgents = new Set(lifecycle.map((row) => row.agentPubkey));

  const { queued, reacting } = reactionWork(
    inputs.reactions,
    nowS,
    mergeTriggers(observedTriggers(inputs.observer), statusTriggers(store)),
  );
  const reactionRows = new Map<string, RunRow>();
  for (const entry of reacting) {
    const channelId = inputs.targets.get(entry.eventId)?.channelId ?? null;
    // A lifecycle row (or a status head at least as new as the 💬) speaks for
    // the same agent and channel; with the channel still unknown, any
    // lifecycle row for the agent does.
    if (
      channelId === null
        ? observedAgents.has(entry.agentPubkey)
        : (spokenFor.get(slotOf(entry.agentPubkey, channelId)) ?? -1) >=
            entry.at ||
          lifecycle.some(
            (row) =>
              row.agentPubkey === entry.agentPubkey &&
              row.channelId === channelId,
          )
    ) {
      continue;
    }
    // A batched turn reacts 💬 on every triggering event: one row per
    // (agent, channel), dated by its earliest reaction.
    const key = `react:${entry.agentPubkey}:${channelId ?? entry.eventId}`;
    if (reactionRows.has(key)) {
      continue;
    }
    reactionRows.set(key, {
      key,
      agentPubkey: entry.agentPubkey,
      turnId: null,
      channelId,
      startedAt: entry.at,
      lastBeatAt: null,
      state: "reacting",
      source: "reaction",
      title: null,
      progress: null,
    });
  }

  const running = [...lifecycle, ...reactionRows.values()].filter((row) =>
    inScope(row.channelId, scope, openChannelId),
  );

  const queuedRows: QueuedRow[] = queued
    .map((entry) => ({
      key: `queued:${entry.agentPubkey}:${entry.eventId}`,
      agentPubkey: entry.agentPubkey,
      eventId: entry.eventId,
      channelId: inputs.targets.get(entry.eventId)?.channelId ?? null,
      at: entry.at,
    }))
    .filter((row) => inScope(row.channelId, scope, openChannelId));

  const done: DoneState = doneState(inputs, scope, openChannelId);

  return { needs, needCounts: counts, running, queued: queuedRows, done };
}
