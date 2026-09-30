/**
 * The single join behind the Work tab (phase-1 §2): needs, running, queued
 * and done from their four families of inputs, scoped once. Pure — the
 * provider and the hook gather inputs, the UI renders the result.
 */

import type { ObserverFrame } from "@/features/agents/lib/observerEvents";
import { activeTurns, observedTriggers } from "./activeTurns.ts";
import { buildNeeds, type NeedInputs, scopedNeeds } from "./needsYou.ts";
import { type ReactionEvent, reactionWork } from "./queuedReactions.ts";
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

  const turns = activeTurns(inputs.observer, nowS, inputs.dismissedTurns);
  const observerRows: RunRow[] = turns.map((turn) => ({
    key: `turn:${turn.agentPubkey}:${turn.turnId}`,
    agentPubkey: turn.agentPubkey,
    turnId: turn.turnId,
    channelId: turn.channelId,
    startedAt: turn.startedAt,
    lastBeatAt: turn.lastBeatAt,
    state: turn.state,
    source: "observer",
  }));
  const observed = new Set(
    observerRows.map((row) => `${row.agentPubkey}:${row.channelId ?? ""}`),
  );
  const observedAgents = new Set(observerRows.map((row) => row.agentPubkey));

  const { queued, reacting } = reactionWork(
    inputs.reactions,
    nowS,
    observedTriggers(inputs.observer),
  );
  const reactionRows = new Map<string, RunRow>();
  for (const entry of reacting) {
    const channelId = inputs.targets.get(entry.eventId)?.channelId ?? null;
    // An observer row for the same agent and channel wins; with the channel
    // still unknown, any observer row for the agent does.
    if (
      channelId === null
        ? observedAgents.has(entry.agentPubkey)
        : observed.has(`${entry.agentPubkey}:${channelId}`)
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
    });
  }

  const running = [...observerRows, ...reactionRows.values()].filter((row) =>
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

  const done: DoneState =
    inputs.metrics.state === "ready"
      ? summarizeDone(
          inputs.metrics.entries,
          inputs.metrics.sinceS,
          scope,
          openChannelId,
        )
      : { state: inputs.metrics.state };

  return { needs, needCounts: counts, running, queued: queuedRows, done };
}
