/**
 * Which channels an agent is a member of, from kind-39002 member snapshots.
 * Each 39002 is a parameterized-replaceable snapshot keyed by `d` =
 * channel id, so only the NEWEST per `d` counts (NIP-33: newer created_at
 * wins; equal created_at → lower id wins). Newest-wins is load-bearing: an
 * older snapshot that still lists a since-removed member must not keep the
 * channel in the agent's list. Pure, React-free for the node runner.
 */

export interface MemberSnapshotEvent {
  tags: string[][];
  created_at: number;
  id: string;
}

/** Newest 39002 per `d` tag (NIP-33 tiebreak). */
function newestPerChannel(
  events: readonly MemberSnapshotEvent[],
): Map<string, MemberSnapshotEvent> {
  const newest = new Map<string, MemberSnapshotEvent>();
  for (const event of events) {
    const d = event.tags.find((tag) => tag[0] === "d")?.[1];
    if (!d) {
      continue;
    }
    const existing = newest.get(d);
    if (
      !existing ||
      event.created_at > existing.created_at ||
      (event.created_at === existing.created_at && event.id < existing.id)
    ) {
      newest.set(d, event);
    }
  }
  return newest;
}

/** Channel ids whose newest member snapshot lists `agentPubkey` as a `p`. */
export function memberChannelIds(
  events: readonly MemberSnapshotEvent[],
  agentPubkey: string,
): Set<string> {
  const target = agentPubkey.toLowerCase();
  const ids = new Set<string>();
  for (const [d, event] of newestPerChannel(events)) {
    const isMember = event.tags.some(
      (tag) =>
        tag[0] === "p" &&
        typeof tag[1] === "string" &&
        tag[1].toLowerCase() === target,
    );
    if (isMember) {
      ids.add(d);
    }
  }
  return ids;
}
