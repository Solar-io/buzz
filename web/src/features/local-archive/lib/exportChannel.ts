import type { RelaySession } from "@/shared/api/relay-session";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
// Loaded lazily so the pure modules stay importable by `node --test`, which
// does not resolve the `@/` bundler alias. Mirrors the same trick in unreact.ts.
import {
  DEFAULT_BOUNDS,
  EXPORT_PAGE_SIZE,
  type ExportBounds,
  type ExportStopReason,
  exportPageFilter,
  planPage,
} from "./exportPlan.ts";

/**
 * The export driver: walk a channel backwards through `until` windows until
 * the relay runs out or a ceiling bites.
 *
 * Everything that *decides* lives in `exportPlan.ts`; this file only does
 * I/O and bookkeeping, so the interesting behaviour stays unit-testable
 * without a relay.
 */

export interface ExportProgress {
  /** Events accepted so far. */
  events: number;
  /** REQ round-trips completed. */
  pages: number;
  /** Oldest `created_at` reached, or null before the first page lands. */
  oldestCreatedAt: number | null;
}

export interface ExportRun {
  events: SignedNostrEvent[];
  pages: number;
  reason: ExportStopReason;
  sameTimestampPages: number;
}

/** A one-shot REQ. Injected so tests can drive the walk without a socket. */
export type QueryPage = (
  session: Pick<RelaySession, "subscribe">,
  filter: ReturnType<typeof exportPageFilter>,
) => Promise<SignedNostrEvent[]>;

/** Generous per-page budget: a deep history page is slower than a lookup. */
const PAGE_TIMEOUT_MS = 15_000;

const defaultQueryPage: QueryPage = async (session, filter) => {
  const { queryOnce } = await import("@/features/channels/lib/unreact.ts");
  return queryOnce(session, filter, PAGE_TIMEOUT_MS);
};

/**
 * Hand the event loop back between pages.
 *
 * The network wait already yields, so this is belt-and-braces for a relay
 * answering from a warm cache: without it a fast local relay can run every
 * page inside one macrotask and the tab stops painting the progress bar.
 */
function defaultBreathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface ExportChannelOptions {
  session: Pick<RelaySession, "subscribe">;
  channelId: string;
  kinds: number[];
  bounds?: ExportBounds;
  pageSize?: number;
  onProgress?: (progress: ExportProgress) => void;
  /** Abort between pages; whatever was collected is returned. */
  signal?: AbortSignal;
  queryPage?: QueryPage;
  breathe?: () => Promise<void>;
}

export async function exportChannelEvents(
  options: ExportChannelOptions,
): Promise<ExportRun> {
  const {
    session,
    channelId,
    kinds,
    bounds = DEFAULT_BOUNDS,
    pageSize = EXPORT_PAGE_SIZE,
    onProgress,
    signal,
    queryPage = defaultQueryPage,
    breathe = defaultBreathe,
  } = options;

  const collected: SignedNostrEvent[] = [];
  const seen = new Set<string>();
  let until: number | null = null;
  let pages = 0;
  let sameTimestampPages = 0;
  let oldestCreatedAt: number | null = null;
  let reason: ExportStopReason = "complete";

  if (kinds.length === 0) {
    return { events: [], pages: 0, reason: "complete", sameTimestampPages: 0 };
  }

  for (;;) {
    if (signal?.aborted) {
      reason = "cancelled";
      break;
    }
    const page = await queryPage(
      session,
      exportPageFilter(channelId, kinds, until, pageSize),
    );
    const plan = planPage({
      page,
      seen,
      totalAccepted: collected.length,
      pageIndex: pages,
      pageSize,
      bounds,
    });
    pages += 1;
    if (plan.sameTimestampPage) {
      sameTimestampPages += 1;
    }
    for (const event of plan.accepted) {
      seen.add(event.id);
      collected.push(event);
      if (oldestCreatedAt === null || event.created_at < oldestCreatedAt) {
        oldestCreatedAt = event.created_at;
      }
    }
    onProgress?.({ events: collected.length, pages, oldestCreatedAt });
    if (plan.done) {
      reason = plan.reason ?? "complete";
      break;
    }
    until = plan.nextUntil;
    await breathe();
  }

  // Pages arrive newest-first and each page is sorted ascending internally,
  // so the concatenation is descending-by-page. One final sort puts the whole
  // archive in reading order.
  collected.sort((a, b) =>
    a.created_at !== b.created_at
      ? a.created_at - b.created_at
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );

  return { events: collected, pages, reason, sameTimestampPages };
}
