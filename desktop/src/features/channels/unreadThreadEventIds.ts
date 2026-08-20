import type { ObservedUnreadEvent } from "./unreadChannelCounts";
import { maxReadAt } from "./readState/readStateFormat";

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

export function readAtForPreservedUnreadMessage(
  messageId: string,
  preservedUnreadMessageIds: ReadonlySet<string>,
  messageReadAt: number | null,
  channelReadAt: number | null,
): number | null {
  return preservedUnreadMessageIds.has(messageId)
    ? messageReadAt
    : maxReadAt(messageReadAt, channelReadAt);
}
