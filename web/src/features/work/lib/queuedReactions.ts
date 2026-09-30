/**
 * Queued and reaction-running work from the ACP's reactions (phase-1 §2.5).
 *
 * The harness reacts 👀 when it queues an event and 💬 while it prompts on
 * it, and removes both with kind-5 deletions when the turn ends
 * (`crates/buzz-acp/src/pool.rs`, REACTION_SEEN / REACTION_WORKING). A
 * reaction carries only an `e` tag — the channel is resolved from the TARGET
 * event by the caller.
 *
 * These rows cover agents the viewer does not own (observer frames are
 * owner-encrypted), so they make no timing claim: a 💬 row says "working since
 * …", never an elapsed heartbeat and never "stalled".
 */

export const REACTION_SEEN = "👀";
export const REACTION_WORKING = "💬";
/**
 * The harness documents a cosmetic stale-👀 race after a crash. Past two
 * hours an unremoved reaction is not a claim worth making.
 */
export const QUEUED_TTL_S = 7_200;

export interface ReactionEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface ReactionEntry {
  agentPubkey: string;
  /** The event the agent reacted to. */
  eventId: string;
  /** When the reaction landed (unix s). */
  at: number;
}

function firstTag(tags: readonly string[][], name: string): string | null {
  const tag = tags.find((candidate) => candidate[0] === name && candidate[1]);
  return tag?.[1] ?? null;
}

/**
 * Queued ⇔ an alive 👀 by agent A on event E, no alive 💬 by A on E, no
 * observed turn of A started by E, and not older than {@link QUEUED_TTL_S}.
 * Reacting ⇔ an alive 💬 by A on E (the caller drops it when an observer row
 * already covers the same agent and channel).
 *
 * "Alive" means no kind-5 from the reaction's OWN author references it — a
 * deletion signed by anyone else deletes nothing.
 */
export function reactionWork(
  events: readonly ReactionEvent[],
  nowS: number,
  triggersByAgent: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): { queued: ReactionEntry[]; reacting: ReactionEntry[] } {
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== 5) {
      continue;
    }
    for (const tag of event.tags) {
      if (tag[0] === "e" && tag[1]) {
        deleted.add(`${event.pubkey}:${tag[1]}`);
      }
    }
  }
  const seen = new Map<string, ReactionEntry>();
  const working = new Map<string, ReactionEntry>();
  for (const event of events) {
    if (event.kind !== 7 || deleted.has(`${event.pubkey}:${event.id}`)) {
      continue;
    }
    const target = firstTag(event.tags, "e");
    if (!target || nowS - event.created_at > QUEUED_TTL_S) {
      continue;
    }
    const bucket =
      event.content === REACTION_SEEN
        ? seen
        : event.content === REACTION_WORKING
          ? working
          : null;
    if (!bucket) {
      continue;
    }
    const key = `${event.pubkey}:${target}`;
    const previous = bucket.get(key);
    if (!previous || previous.at < event.created_at) {
      bucket.set(key, {
        agentPubkey: event.pubkey,
        eventId: target,
        at: event.created_at,
      });
    }
  }
  const queued: ReactionEntry[] = [];
  for (const [key, entry] of seen) {
    if (working.has(key)) {
      continue;
    }
    if (triggersByAgent.get(entry.agentPubkey)?.has(entry.eventId)) {
      continue;
    }
    queued.push(entry);
  }
  const byAge = (a: ReactionEntry, b: ReactionEntry) =>
    a.at - b.at || a.eventId.localeCompare(b.eventId);
  return {
    queued: queued.sort(byAge),
    reacting: [...working.values()].sort(byAge),
  };
}
