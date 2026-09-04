import type { RelaySession } from "@/shared/api/relay-session";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/** Default wait for the relay's EOSE before settling with what arrived. */
export const REMINDER_QUERY_TIMEOUT_MS = 12_000;

/** The slice of {@link RelaySession} a one-shot read needs. */
export type QueryableSession = Pick<RelaySession, "subscribe">;

/**
 * One-shot REQ: collect until EOSE (or the timeout), then close.
 *
 * `RelaySession.subscribe` is a LIVE subscription — it never completes on its
 * own — so a snapshot read has to close its own handle. Resolving on the
 * timeout rather than rejecting is deliberate: a slow relay should render a
 * short feed, not an error screen.
 *
 * Closing is harder than it looks, and both halves are load-bearing:
 *
 *  - `onEose` can fire SYNCHRONOUSLY from inside `subscribe` (a fake, or a
 *    very fast relay), before the handle exists. So the close is deferred to
 *    a microtask in that case, and re-attempted once `subscribe` returns.
 *  - which means two paths can both reach it, so `closeOnce` guards against
 *    calling the same handle twice. A duplicate close is not harmless: the
 *    session's `activeSubs` bookkeeping is keyed by subscription id, and a
 *    second release can drop a subscription a later reader has since opened.
 */
export function queryOnce(
  session: QueryableSession,
  filter: Parameters<RelaySession["subscribe"]>[0],
  timeoutMs = REMINDER_QUERY_TIMEOUT_MS,
): Promise<SignedNostrEvent[]> {
  return new Promise((resolve) => {
    const collected: SignedNostrEvent[] = [];
    let settled = false;
    let closed = false;
    let unsubscribe: (() => void) | null = null;

    const closeOnce = () => {
      if (closed || !unsubscribe) {
        return;
      }
      closed = true;
      unsubscribe();
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (unsubscribe) {
        closeOnce();
      } else {
        queueMicrotask(closeOnce);
      }
      resolve(collected);
    };

    const timer = setTimeout(finish, timeoutMs);
    unsubscribe = session.subscribe(filter, {
      onEvent: (event) => collected.push(event),
      onEose: finish,
    });
    if (settled) {
      closeOnce();
    }
  });
}
