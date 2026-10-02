import type { NostrFilter } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { cleanWorkText } from "./workText.ts";
import type { DoneRow, RunRow, WorkFeed } from "./workTypes.ts";

export type AgentActivity = ReadonlyMap<string, readonly SignedNostrEvent[]>;

/** One shared message cache per agent and channel. */
export function activitySlot(agentPubkey: string, channelId: string): string {
  return `${agentPubkey}|${channelId}`;
}

/** The exact message window for a row; metric-only turns get a 1h lookback. */
export function activityWindow(row: RunRow | DoneRow): {
  since: number;
  until?: number;
} | null {
  if ("at" in row) {
    const ended = row.endedAt ?? row.at;
    return { since: row.startedAt ?? row.at - 3600, until: ended + 30 };
  }
  return row.startedAt === null ? null : { since: row.startedAt };
}

/** Latest own kind-9 line inside the row's window, independent of REQ order. */
export function latestActivity(
  row: RunRow | DoneRow,
  activity: AgentActivity | undefined,
): string | null {
  const window = activityWindow(row);
  if (!row.channelId || !window || !activity) {
    return null;
  }
  const messages =
    activity.get(activitySlot(row.agentPubkey, row.channelId)) ?? [];
  const last = messages
    .filter(
      (event) =>
        event.kind === 9 &&
        event.pubkey === row.agentPubkey &&
        event.tags.some((tag) => tag[0] === "h" && tag[1] === row.channelId) &&
        event.created_at >= window.since &&
        (window.until === undefined || event.created_at <= window.until),
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  return last ? cleanWorkText(last.content) || null : null;
}

export interface ActivityQuery {
  slot: string;
  key: string;
  filters: NostrFilter[];
}

/** Keep only the five newest messages per requested window, deduplicated. */
export function mergeActivityMessages(
  previous: readonly SignedNostrEvent[],
  received: readonly SignedNostrEvent[],
  filters: readonly NostrFilter[],
): SignedNostrEvent[] {
  const events = [
    ...new Map([...previous, ...received].map((e) => [e.id, e])).values(),
  ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const kept = new Map<string, SignedNostrEvent>();
  for (const filter of filters) {
    const matches = events.filter(
      (e) =>
        e.kind === 9 &&
        filter.authors?.includes(e.pubkey) &&
        e.tags.some((t) => t[0] === "h" && filter["#h"]?.includes(t[1])) &&
        e.created_at >= (filter.since ?? 0) &&
        (filter.until === undefined || e.created_at <= filter.until),
    );
    for (const event of matches.slice(0, 5)) {
      kept.set(event.id, event);
    }
  }
  return [...kept.values()];
}

/**
 * One closed history REQ per pair (max 30), with up to ten turn windows in
 * it. Separate filters keep a newer turn's five messages from crowding out
 * an older Done row. Only running pairs renew their key each minute.
 */
export function activityQueries(feed: WorkFeed, nowS: number): ActivityQuery[] {
  const pairs = new Map<string, { filters: NostrFilter[]; running: boolean }>();
  const rows = [
    ...feed.running,
    ...(feed.done.state === "ready" ? feed.done.rows : []),
  ];
  for (const row of rows) {
    const window = activityWindow(row);
    if (!row.channelId || !window) {
      continue;
    }
    const slot = activitySlot(row.agentPubkey, row.channelId);
    if (!pairs.has(slot) && pairs.size >= 30) {
      continue;
    }
    const pair = pairs.get(slot) ?? { filters: [], running: false };
    const filter: NostrFilter = {
      kinds: [9],
      authors: [row.agentPubkey],
      "#h": [row.channelId],
      ...window,
      limit: 5,
    };
    if (
      pair.filters.length < 10 &&
      !pair.filters.some(
        (f) => f.since === filter.since && f.until === filter.until,
      )
    ) {
      pair.filters.push(filter);
    }
    pair.running ||= !("at" in row);
    pairs.set(slot, pair);
  }
  return [...pairs].map(([slot, pair]) => ({
    slot,
    filters: pair.filters,
    key: JSON.stringify([
      pair.filters,
      pair.running ? Math.floor(nowS / 60) : null,
    ]),
  }));
}

/** Live messages kept per (agent, channel) on top of history. */
export const LIVE_HELD_PER_SLOT = 50;

/** How long after a turn ends its channel is still listened to live. */
export const LIVE_GRACE_S = 90;

export interface LiveSlot {
  slot: string;
  agentPubkey: string;
  channelId: string;
  /** Listen from here: the turn's start (no earlier than an hour ago). */
  since: number;
}

/**
 * The (agent, channel) pairs whose words can still change a row: every
 * running turn, and every Done turn that ended within {@link LIVE_GRACE_S}
 * — an agent's final reply can land after the turn's history REQ closed.
 * Capped at 30, like the history queries.
 */
export function liveSlots(feed: WorkFeed, nowS: number): LiveSlot[] {
  const out = new Map<string, LiveSlot>();
  const add = (row: RunRow | DoneRow, startedAt: number | null) => {
    if (!row.channelId || out.size >= 30) {
      return;
    }
    const slot = activitySlot(row.agentPubkey, row.channelId);
    const since = Math.max(startedAt ?? nowS - 3600, nowS - 3600);
    const previous = out.get(slot);
    if (!previous || since < previous.since) {
      out.set(slot, {
        slot,
        agentPubkey: row.agentPubkey,
        channelId: row.channelId,
        since,
      });
    }
  };
  for (const row of feed.running) {
    add(row, row.startedAt);
  }
  if (feed.done.state === "ready") {
    for (const row of feed.done.rows) {
      const ended = row.endedAt ?? row.at;
      if (nowS - ended <= LIVE_GRACE_S) {
        add(row, row.startedAt ?? null);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.slot.localeCompare(b.slot));
}
