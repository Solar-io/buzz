/**
 * The two provider-level decisions about a huddle call's lifetime, pulled out
 * of `HuddleSessionProvider` because the first cut got one of them wrong in
 * a way no unit test of the components could see and the live relay did
 * (2026-09-19 dev deploy: Join dialed `/huddle/null/audio`).
 *
 * The trap: React runs every effect of one commit in order, against THAT
 * commit's state. The pending-join effect calls `join()`, which schedules
 * `status = "connecting"` — but the "call is over" effect in the SAME commit
 * still reads `status === "idle"`, and by then the pending marker has been
 * cleared, so it concluded the call had ended and dropped the target. The
 * audio hook re-rendered with a null channel, and the socket it opened when
 * the mic grant resolved carried that null. Deciding on a TRANSITION (from a
 * live status to idle) instead of on the idle state alone is what fixes it.
 */

/** Mirrors `HuddleStatus` in `useHuddleAudio.ts`. */
export type CallStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * Should a requested join be dispatched to the audio hook now?
 *
 * Only once the hook is rendering the requested channel (`hookChannelId`),
 * and only from a status `join()` can start from: idle, or error — a join
 * that failed (mic denied, unplugged) leaves the hook in `error` with its
 * graph torn down, and a retry from the bar must be allowed to run.
 */
export function shouldDispatchJoin(input: {
  pendingChannelId: string | null;
  hookChannelId: string | null;
  status: CallStatus;
}): boolean {
  const { pendingChannelId, hookChannelId, status } = input;
  if (pendingChannelId === null || pendingChannelId !== hookChannelId) {
    return false;
  }
  return status === "idle" || status === "error";
}

/**
 * Has the call ENDED — so the target, dock, panel and pill must all go?
 *
 * True only on a transition from a live status (connected/reconnecting: a
 * leave, a relay-ended room, or an exhausted redial ladder) to idle. An idle
 * status with an idle predecessor is a call that has not started, and an
 * idle read in the same commit as the join dispatch is exactly the race in
 * the module comment. `connecting → idle` is not an end either: the hook
 * reports a failed start as `error`, never as idle.
 */
export function isCallOver(input: {
  hasTarget: boolean;
  previousStatus: CallStatus;
  status: CallStatus;
}): boolean {
  const { hasTarget, previousStatus, status } = input;
  if (!hasTarget || status !== "idle") {
    return false;
  }
  return previousStatus === "connected" || previousStatus === "reconnecting";
}

/**
 * Whether an async microphone/audio-graph continuation still belongs to the
 * current join. A leave can happen while getUserMedia or AudioWorklet is
 * awaiting; stale continuations must stop their local stream and never open
 * a socket for the old room.
 */
export function shouldContinueAudioJoin(input: {
  joinGeneration: number;
  currentGeneration: number;
  wantsConnection: boolean;
}): boolean {
  return (
    input.wantsConnection && input.joinGeneration === input.currentGeneration
  );
}
