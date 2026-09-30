/**
 * "Done today" from NIP-AM turn metrics, kind 44200 (phase-1 §2.6).
 *
 * Agent-authored, `p` = owner, NIP-44 v2 with the SAME (agent, owner) pair as
 * the 24200 observer frames — so the owner's key decrypts them exactly as
 * `ObserverProvider.decodeFrame` does. No `h` tag: the channel lives inside
 * the payload. The decrypt itself happens in WorkProvider; this module only
 * parses plaintext and folds entries into a summary.
 *
 * Honesty rules: an envelope that does not decrypt is LOCKED and never
 * counted as done; a turn is counted once however many metrics name it.
 */

import type { DoneRow, DoneSummary, WorkScope } from "./workTypes.ts";

export const KIND_AGENT_TURN_METRIC = 44200;

/** One kind-44200 envelope after the decrypt attempt. */
export type MetricEntry =
  | {
      locked: false;
      eventId: string;
      agentPubkey: string;
      createdAt: number;
      channelId: string | null;
      turnId: string | null;
      /** End of turn, unix s (payload `timestamp`, else created_at). */
      at: number;
      stopReason: string | null;
    }
  | { locked: true; eventId: string; createdAt: number };

export interface ParsedMetric {
  channelId: string | null;
  turnId: string | null;
  at: number | null;
  stopReason: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Parse a decrypted NIP-AM payload; null when it is not one. */
export function parseTurnMetric(plaintext: string): ParsedMetric | null {
  try {
    const raw = JSON.parse(plaintext) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || typeof raw.harness !== "string") {
      return null;
    }
    const ms =
      typeof raw.timestamp === "string"
        ? Date.parse(raw.timestamp)
        : Number.NaN;
    return {
      channelId: str(raw.channelId),
      turnId: str(raw.turnId),
      at: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
      stopReason: str(raw.stopReason),
    };
  } catch {
    return null;
  }
}

/** Local midnight today, unix seconds — the REQ's `since`. */
export function localMidnight(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/**
 * The turns finished since `sinceS`: ONE row per distinct turn (turnId, else
 * the event id — a replayed metric must not list a turn twice), newest first,
 * with the count and the locked tally. Channel scope keeps only turns in the
 * open channel (a channel-less turn is Everywhere-only). An envelope that
 * did not decrypt is LOCKED: tallied, never listed and never counted as done.
 */
export function summarizeDone(
  entries: readonly MetricEntry[],
  sinceS: number,
  scope: WorkScope = "everywhere",
  channelId: string | null = null,
): DoneSummary {
  const byTurn = new Map<string, DoneRow>();
  let locked = 0;
  for (const entry of entries) {
    if (entry.createdAt < sinceS) {
      continue;
    }
    if (entry.locked) {
      locked += 1;
      continue;
    }
    if (scope === "channel" && channelId && entry.channelId !== channelId) {
      continue;
    }
    const key = entry.turnId ?? entry.eventId;
    const previous = byTurn.get(key);
    if (previous && previous.at >= entry.at) {
      continue;
    }
    byTurn.set(key, {
      key,
      agentPubkey: entry.agentPubkey,
      channelId: entry.channelId,
      at: entry.at,
      stopReason: entry.stopReason,
    });
  }
  const rows = [...byTurn.values()].sort(
    (a, b) => b.at - a.at || a.key.localeCompare(b.key),
  );
  return {
    state: "ready",
    count: rows.length,
    locked,
    last: rows[0] ?? null,
    rows,
  };
}
