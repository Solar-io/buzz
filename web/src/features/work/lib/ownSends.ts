/**
 * Event ids this browser signed and sent (phase-1 §5): the agent-done toast
 * fires only for a turn one of YOUR messages started. Every agent's every
 * turn would flood a 20-agent fleet; a turn whose trigger author is unknown
 * raises nothing.
 *
 * A bounded LRU in module scope: sends are per session and a reload forgets
 * them, which only means a turn started before the reload never toasts.
 */

const CAPACITY = 200;
const sent = new Set<string>();

/** Remember one signed event id (oldest evicted past {@link CAPACITY}). */
export function recordOwnSend(eventId: string): void {
  if (!eventId) {
    return;
  }
  sent.delete(eventId);
  sent.add(eventId);
  while (sent.size > CAPACITY) {
    const oldest = sent.values().next().value;
    if (oldest === undefined) {
      break;
    }
    sent.delete(oldest);
  }
}

/** Did any of these events come from this browser? */
export function includesOwnSend(eventIds: readonly string[]): boolean {
  return eventIds.some((id) => sent.has(id));
}

/** Test seam. */
export function resetOwnSends(): void {
  sent.clear();
}
