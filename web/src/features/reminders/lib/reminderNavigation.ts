import type { ReminderTarget } from "./reminderTypes.ts";

/** Where a "jump to message" click lands in the web app's `/repos` route. */
export interface ReminderDestination {
  /** The `?c=` search param — the channel to open. */
  channelId: string;
  /** The `?m=` search param — the message to scroll to and flash. */
  messageId: string;
}

/**
 * A target is navigable only when it carries a non-empty channel AND event id.
 *
 * "Present" is not the same as "usable": the desktop's creation site stores
 * `channelId ?? ""`, and this client's reader maps a spec-shaped NIP-ER
 * target (which has no channel at all) to an empty `channelId`. Both produce
 * a target object that exists and routes nowhere — `/repos?c=` opens the
 * empty channel view — so the emptiness has to be checked, not the presence.
 *
 * `authorPubkey` is deliberately NOT required here, unlike the desktop's
 * `hasNavigableTarget`: it is used to render an author label, and a missing
 * label is no reason to refuse to open a message that is perfectly reachable.
 */
export function hasNavigableTarget(
  target: ReminderTarget | undefined,
): target is ReminderTarget {
  return (
    target !== undefined && target.channelId !== "" && target.eventId !== ""
  );
}

/**
 * The `/repos` search params for a reminder, or null when it points nowhere.
 *
 * The web needs no event fetch to resolve a thread root — unlike the desktop,
 * whose reminder click has to enter a thread panel. `/repos?c=…&m=…` scrolls
 * the channel timeline to the message and flashes it, which is the same
 * destination without the round trip.
 */
export function reminderDestination(
  target: ReminderTarget | undefined,
): ReminderDestination | null {
  if (!hasNavigableTarget(target)) {
    return null;
  }
  return { channelId: target.channelId, messageId: target.eventId };
}
