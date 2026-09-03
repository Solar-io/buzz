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

/**
 * Add-agent button feedback for the snapshot preview dialog — the same
 * honesty clock as the pending strip, derived through pendingRowState so the
 * two surfaces can never disagree about what a silent 20s means.
 *
 * `no-response` deliberately RE-ENABLES the button: an un-acked create was
 * never applied (no ack = no desktop ran it), so retrying cannot mint the
 * agent twice — but the amber "no desktop responded" line says why it
 * silently did nothing. An error ack (`refused`) also leaves the button
 * enabled; only `sending` and `applied` disable it.
 */
export type SnapshotAddFeedback =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "no-response" }
  | { phase: "applied" }
  | { phase: "refused"; error: string | null };

export function snapshotAddFeedback(
  sentAt: number | null,
  ack: { ok: boolean; error?: string } | undefined,
  now: number,
): SnapshotAddFeedback {
  if (ack) {
    return ack.ok
      ? { phase: "applied" }
      : { phase: "refused", error: ack.error ?? null };
  }
  if (sentAt === null) {
    return { phase: "idle" };
  }
  const { status } = pendingRowState(sentAt, undefined, now);
  return status === "unknown" ? { phase: "no-response" } : { phase: "sending" };
}
