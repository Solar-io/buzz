/**
 * Pure state machine for one pending-command row in the strip. Extracted
 * from PendingCommandsStrip (QA 2026-09-02, HIGH): the strip used to compute
 * `timedOut` at render time, but on a quiet relay nothing re-rendered between
 * the 20s timeout and the 80s prune, so the user never saw the "?" honest
 * -failure state. The strip now re-renders on a clock while anything is
 * pending (useTick) and derives each row's state through this pure function,
 * which the unit suite pins against hardcoded times.
 */

/** No ack by this age → "?" + the "Is Buzz running?" hint (not a failure). */
export const ACK_TIMEOUT_MS = 20_000;

export type PendingRowStatus = "sent" | "applied" | "error" | "unknown";

/**
 * Derive a row's display state at time `now` (ms epoch). An ack is final;
 * without one, the row ages from "sent" to "unknown" ("?") after
 * ACK_TIMEOUT_MS. `timedOut` separately gates the hint sentence.
 */
export function pendingRowState(
  sentAt: number,
  ack: { ok: boolean } | undefined,
  now: number,
): { status: PendingRowStatus; timedOut: boolean } {
  if (ack) {
    return { status: ack.ok ? "applied" : "error", timedOut: false };
  }
  const timedOut = now - sentAt > ACK_TIMEOUT_MS;
  return { status: timedOut ? "unknown" : "sent", timedOut };
}
