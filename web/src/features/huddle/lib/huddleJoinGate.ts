/**
 * The join gate for a huddle bar: whether the Join affordance may render
 * live, and the honest reason when it may not.
 *
 * Three distinct no states, and conflating them is how the V1b defects
 * happened:
 *
 * - `ended` — the relay retired this room (kind-48103 seen, or the backing
 *   channel's kind-39000 says archived). A dead huddle must NOT render a
 *   live Join at all, and a countdown badge must not keep ticking; the
 *   user-facing wording says the huddle is over.
 * - `unlinked` — resolution SETTLED (the targeted kind-48106 query came
 *   back EOSE/timeout) and no parent linkage exists anywhere. The relay
 *   refuses audio on an ephemeral channel with no parent link
 *   ("ephemeral channel requires parent linkage", audio/handler.rs), so
 *   disabled with that reason — and ONLY that reason. A disabled button
 *   that blames "no permanent channel" while the link query is merely
 *   still in flight is the false lockout the cold-load path exists to fix.
 * - `resolving` — no parent yet, but the linkage query has not settled.
 *   Disabled WITHOUT a failure reason (the honest answer is "still
 *   looking"), because the replay may land the link a moment later.
 */

export interface HuddleJoinGateInput {
  /** Merged parent resolution: registry link first, targeted query second. */
  parentChannelId: string | null;
  /** The relay has ended this huddle (48103, or the 39000 says archived). */
  huddleEnded: boolean;
  /** The targeted linkage query has settled (EOSE or timeout). */
  resolutionSettled: boolean;
}

export interface HuddleJoinGate {
  state: "joinable" | "ended" | "unlinked" | "resolving";
  /** May the Join affordance render live at all. */
  joinable: boolean;
  /** Why joining is refused (ended/unlinked); null while joinable/resolving. */
  reason: string | null;
  /** Non-failure hint for the resolving state; null otherwise. */
  hint: string | null;
}

export const HUDDLE_ENDED_REASON = "This huddle has ended.";
export const HUDDLE_UNLINKED_REASON =
  "This room has no parent channel link, and the relay refuses audio without one.";
export const HUDDLE_RESOLVING_HINT = "Looking up this huddle's parent channel…";

export function huddleJoinGate(input: HuddleJoinGateInput): HuddleJoinGate {
  // Ended outranks everything: a room the relay archived is dead even if a
  // stale link is still in hand — joining would be refused with "channel
  // is archived".
  if (input.huddleEnded) {
    return {
      state: "ended",
      joinable: false,
      reason: HUDDLE_ENDED_REASON,
      hint: null,
    };
  }
  if (input.parentChannelId) {
    return { state: "joinable", joinable: true, reason: null, hint: null };
  }
  if (!input.resolutionSettled) {
    return {
      state: "resolving",
      joinable: false,
      reason: null,
      hint: HUDDLE_RESOLVING_HINT,
    };
  }
  return {
    state: "unlinked",
    joinable: false,
    reason: HUDDLE_UNLINKED_REASON,
    hint: null,
  };
}
