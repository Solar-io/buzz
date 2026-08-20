import type { ObservedUnreadEvent } from "./unreadChannelCounts";

export function collectUnreadThreadEventIds(
  nativeEventIds: readonly string[] | undefined,
  observedEvents: Iterable<ObservedUnreadEvent> | undefined,
  readAtForObservedEvent: (event: ObservedUnreadEvent) => number | null,
): Set<string> {
  if (nativeEventIds) return new Set(nativeEventIds);
  const ids = new Set<string>();
  for (const event of observedEvents ?? []) {
    if (
      event.rootId !== null &&
      event.createdAt > (readAtForObservedEvent(event) ?? 0)
    ) {
      ids.add(event.id);
    }
  }
  return ids;
}
