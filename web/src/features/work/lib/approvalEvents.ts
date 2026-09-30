/**
 * Workflow approvals from the relay's execution events (phase-1 §2.1 source 3).
 *
 * The relay signs three kinds for an approval gate (`buzz_core::kind`):
 * 46010 requested, 46011 granted, 46012 denied. All three carry the SAME
 * `["approval", <ref>]` tag — the hex of the stored token hash, which is also
 * the `d` tag a 46030/46031 decision carries — so the ref is the one key that
 * pairs a request with its outcome. `run` is the run, and one run can park on
 * several approvals (one per gated step), so pairing on `run` would let one
 * step's grant clear another step's request.
 *
 * Pure: events in, pending approvals out. No relay, no clock.
 */

export const KIND_APPROVAL_REQUESTED = 46010;
export const KIND_APPROVAL_GRANTED = 46011;
export const KIND_APPROVAL_DENIED = 46012;
export const APPROVAL_KINDS = [
  KIND_APPROVAL_REQUESTED,
  KIND_APPROVAL_GRANTED,
  KIND_APPROVAL_DENIED,
] as const;

/** The subset of a Nostr event the approval join reads. */
export interface ApprovalEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface PendingApproval {
  /** Hex of the stored token hash — the `d` tag of a grant/deny decision. */
  ref: string;
  /** The 46010 event id. */
  eventId: string;
  workflowId: string | null;
  runId: string | null;
  stepId: string | null;
  channelId: string | null;
  /** The approval message, verbatim (relay-authored human text). */
  text: string;
  createdAt: number;
  /** NIP-40 `expiration` when the relay sends one; null otherwise. */
  expiresAt: number | null;
}

function tagValue(tags: readonly string[][], name: string): string | null {
  const tag = tags.find((candidate) => candidate[0] === name && candidate[1]);
  return tag?.[1] ?? null;
}

function expirationOf(tags: readonly string[][]): number | null {
  const raw = tagValue(tags, "expiration");
  if (raw === null) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Requests (46010) with no outcome (46011/46012) carrying the same `approval`
 * ref, newest first. A request without a ref cannot be acted on (the
 * decision event has nothing to put in `d`) and is dropped rather than shown
 * as a button that cannot work.
 */
export function pendingApprovals(
  events: readonly ApprovalEvent[],
): PendingApproval[] {
  const decided = new Set<string>();
  for (const event of events) {
    if (
      event.kind === KIND_APPROVAL_GRANTED ||
      event.kind === KIND_APPROVAL_DENIED
    ) {
      const ref = tagValue(event.tags, "approval");
      if (ref) {
        decided.add(ref);
      }
    }
  }
  const byRef = new Map<string, PendingApproval>();
  for (const event of events) {
    if (event.kind !== KIND_APPROVAL_REQUESTED) {
      continue;
    }
    const ref = tagValue(event.tags, "approval");
    if (!ref || decided.has(ref)) {
      continue;
    }
    const previous = byRef.get(ref);
    if (previous && previous.createdAt >= event.created_at) {
      continue;
    }
    byRef.set(ref, {
      ref,
      eventId: event.id,
      workflowId: tagValue(event.tags, "d"),
      runId: tagValue(event.tags, "run"),
      stepId: tagValue(event.tags, "step"),
      channelId: tagValue(event.tags, "h"),
      text: event.content.trim(),
      createdAt: event.created_at,
      expiresAt: expirationOf(event.tags),
    });
  }
  return [...byRef.values()].sort(
    (a, b) => b.createdAt - a.createdAt || a.ref.localeCompare(b.ref),
  );
}
