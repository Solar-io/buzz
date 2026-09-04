import type { RelaySession } from "@/shared/api/relay-session";
import type {
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import {
  buildReactionDeleteTemplate,
  ownReactionFilter,
  pickOwnReactionEventId,
} from "./reactions.ts";

/**
 * Removing your own reaction.
 *
 * There is no "un-react" event in NIP-25. A removal is a NIP-09 deletion
 * (kind 5) naming your own kind-7 by id — an id the client does not hold,
 * because `sendReaction` fires and forgets and {@link ReactionIndex} stores
 * pubkeys, not reaction event ids. So the id is fetched the way the desktop's
 * `remove_reaction` Tauri command fetches it (`commands/messages.rs`): a REQ
 * for `{"kinds":[7],"#e":[target],"authors":[me]}`, then match on content.
 *
 * The relay side is what makes this the only correct mechanism:
 * `handlers/side_effects.rs::validate_standard_deletion_event` refuses a
 * kind-5 whose target was authored by anyone but the actor, and
 * `handlers/ingest.rs` refuses one that does not reference exactly one target
 * — so a second kind-7, or a kind-5 aimed at the *message*, would both be
 * wrong (the latter would delete the message).
 */

/** How long to wait for the relay's EOSE before giving up on the lookup. */
const LOOKUP_TIMEOUT_MS = 8_000;

/** Signs the deletion. Injected so this module has no value imports, which
 *  is what lets `node --test` (no path-alias resolver) exercise the flow. */
export type EventSigner = (
  template: Omit<UnsignedNostrEvent, "created_at">,
) => Promise<SignedNostrEvent>;

/** Loads the app signer only when a removal actually happens. */
const defaultSigner: EventSigner = async (template) => {
  const { signNostrEvent } = await import("@/shared/lib/nostr-signer");
  return signNostrEvent(template);
};

export interface UnreactResult {
  ok: boolean;
  message: string;
}

type QueryableSession = Pick<RelaySession, "subscribe">;
type PublishableSession = Pick<RelaySession, "subscribe" | "publish">;

/**
 * One-shot REQ: collect events until EOSE (or the timeout), then close.
 * The relay session only offers a live `subscribe`, so this wraps it.
 */
export function queryOnce(
  session: QueryableSession,
  filters: Parameters<RelaySession["subscribe"]>[0],
  timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<SignedNostrEvent[]> {
  return new Promise((resolve) => {
    const collected: SignedNostrEvent[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    // Closing exactly once. On a synchronous EOSE `finish` runs before
    // `subscribe` returns, so it queues a microtask to close; the
    // `if (settled)` check below then closes as soon as the handle exists, and
    // the queued microtask would close a second time. Relay sessions reuse
    // subscription ids, so the second close can land on somebody else's REQ.
    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe?.();
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      // A synchronous EOSE from a fake (or a very fast relay) can land before
      // `subscribe` has returned its handle; close on the next tick then.
      if (unsubscribe) {
        close();
      } else {
        queueMicrotask(close);
      }
      resolve(collected);
    };
    timer = setTimeout(finish, timeoutMs);
    unsubscribe = session.subscribe(filters, {
      onEvent: (event) => collected.push(event),
      onEose: finish,
    });
    if (settled) {
      close();
    }
  });
}

/**
 * Delete the viewer's own reaction on a message. Resolves `ok: false` with a
 * reason rather than throwing, so a caller can toast it.
 */
export async function unreactToMessage(
  session: PublishableSession,
  options: { targetEventId: string; emoji: string; selfPubkey: string },
  signEvent: EventSigner = defaultSigner,
): Promise<UnreactResult> {
  const mine = await queryOnce(
    session,
    ownReactionFilter(options.targetEventId, options.selfPubkey),
  );
  const reactionEventId = pickOwnReactionEventId(mine, options);
  if (!reactionEventId) {
    return { ok: false, message: "Could not find your reaction to remove." };
  }
  const event = await signEvent(buildReactionDeleteTemplate(reactionEventId));
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}
