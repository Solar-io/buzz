/**
 * The two transports the projects surface reads through, and the rule for
 * choosing between them.
 *
 * The relay speaks the same filters over both, but only one of them carries
 * the composite `(created_at, id)` cursor NIP-MP mode 1 needs:
 *
 * - `POST /query` (NIP-98 authenticated) parses the request twice, keeping the
 *   raw JSON so extension fields survive — `before_id` among them
 *   (`crates/buzz-relay/src/api/bridge.rs`). This is the exhaustive path.
 * - The websocket REQ path deserializes each filter into a plain
 *   `nostr::Filter`, whose deserializer drops unknown fields, so `before_id`
 *   is discarded with no error. A websocket reader is in mode 2.
 *
 * Enumeration prefers HTTP and falls back to the socket, which keeps the
 * listing working for a session that reads over the socket but cannot pass the
 * bridge's NIP-98 and membership checks.
 */

import type { RelaySession } from "@/shared/api/relay-session";
import type { NostrFilter } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  enumerateEventsComposite,
  enumerateEventsUntilOnly,
  type EnumerationExtraFilter,
  type EnumerationPageFilter,
  type EnumerationResult,
} from "./projectEnumeration.ts";

/** One websocket REQ's worth of patience before treating it as answered. */
const WS_QUERY_TIMEOUT_MS = 10_000;

/**
 * Requested page size. Small enough that a stalled page is not a long wait,
 * large enough that a community of a few hundred repositories is one or two
 * round trips — and comfortably under Buzz's advertised 1000-event cap, which
 * matters: see {@link effectivePageSize}.
 */
export const ENUMERATION_PAGE_SIZE = 200;

/**
 * Both enumeration modes read a short page as "exhausted", and that inference
 * is only sound when the relay never returns fewer events than the *effective*
 * limit while matches remain. If the relay silently clamps a requested 200 to
 * a smaller cap, every page is short and enumeration stops on the first one,
 * losing the rest without a word. NIP-11's `limitation.max_limit` is the
 * relay's own statement of that cap, so it is fetched once and the request is
 * clamped to it. When it cannot be read, the requested size stands and the
 * collection is marked possibly incomplete rather than claimed as whole.
 */
let pageSizePromise: Promise<{ pageSize: number; verified: boolean }> | null =
  null;

export function effectivePageSize(): Promise<{
  pageSize: number;
  verified: boolean;
}> {
  pageSizePromise ??= (async () => {
    try {
      const response = await fetch(
        `${relayHttpBaseUrl().replace(/\/+$/, "")}/`,
        { headers: { accept: "application/nostr+json" } },
      );
      if (!response.ok) throw new Error(`NIP-11 ${response.status}`);
      const document: unknown = await response.json();
      const maxLimit = (
        document as { limitation?: { max_limit?: unknown } } | null
      )?.limitation?.max_limit;
      if (typeof maxLimit !== "number" || !Number.isFinite(maxLimit)) {
        throw new Error("NIP-11 document declares no max_limit");
      }
      return {
        pageSize: Math.max(1, Math.min(ENUMERATION_PAGE_SIZE, maxLimit)),
        verified: true,
      };
    } catch {
      return { pageSize: ENUMERATION_PAGE_SIZE, verified: false };
    }
  })();
  return pageSizePromise;
}

/** Test/HMR seam — drops the cached NIP-11 answer. */
export function resetEffectivePageSize(): void {
  pageSizePromise = null;
}

/** One page over the NIP-98 HTTP bridge, which honours `before_id`. */
export async function httpQueryPage(
  filter: EnumerationPageFilter,
): Promise<SignedNostrEvent[]> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/query`;
  const body = JSON.stringify([filter]);
  const authorization = await makeNip98AuthHeader(url, "POST", { body });
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Relay query failed (${response.status})`);
  }
  const rows: unknown = await response.json();
  return Array.isArray(rows) ? (rows as SignedNostrEvent[]) : [];
}

/**
 * One page over the live websocket session. Resolves at EOSE, or at the
 * timeout with whatever arrived — a relay that never answers must not hang the
 * listing.
 */
export function wsQueryPage(
  session: RelaySession,
  filter: NostrFilter,
): Promise<SignedNostrEvent[]> {
  return new Promise((resolve) => {
    const events: SignedNostrEvent[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(events);
    };
    const timer = setTimeout(finish, WS_QUERY_TIMEOUT_MS);
    const unsubscribe = session.subscribe(filter, {
      onEvent: (event) => events.push(event),
      onEose: finish,
    });
  });
}

/**
 * Enumerate `kinds` exhaustively, preferring the cursor-bearing HTTP bridge.
 *
 * A bridge failure is not fatal — it usually means this session cannot pass
 * NIP-98 or the membership check, not that the data is gone — so the socket
 * answers instead under mode 2's boundary drain.
 */
export async function enumerateWithBestTransport(
  session: RelaySession,
  kinds: number[],
  extraFilter?: EnumerationExtraFilter,
  signal?: AbortSignal,
): Promise<EnumerationResult> {
  const { pageSize, verified } = await effectivePageSize();
  const mark = (result: EnumerationResult): EnumerationResult =>
    verified ? result : { ...result, possiblyIncomplete: true };

  try {
    return mark(
      await enumerateEventsComposite(
        httpQueryPage,
        kinds,
        pageSize,
        extraFilter,
        signal,
      ),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return mark(
      await enumerateEventsUntilOnly(
        (filter) => wsQueryPage(session, filter as NostrFilter),
        kinds,
        pageSize,
        extraFilter,
        signal,
      ),
    );
  }
}
