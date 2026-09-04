import type { NostrFilter } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Paging plan for a channel export.
 *
 * The relay is the source of truth, not the IndexedDB timeline cache: that
 * cache is capped at 500 rows per channel, only exists for channels the
 * viewer has actually opened, and stores parsed `TimelineMessage` rows whose
 * `sig`/`tags` were dropped at parse time — so it can neither reach far back
 * enough nor produce something a reader could re-verify later. See
 * `features/channels/lib/timelineCache.ts` (CACHE_CAP) and
 * `features/channels/lib/messageBuffer.ts` (TimelineMessage).
 *
 * So an export walks backwards through `until` windows, exactly the way
 * scroll-up pagination already does, and every function that decides *what
 * to ask for next* and *when to stop* lives here, pure and testable.
 */

/** Events requested per REQ. Matches the relay's comfortable page size. */
export const EXPORT_PAGE_SIZE = 200;

/**
 * Bounds exist so a huge channel cannot run the tab out of memory or spin
 * forever against a relay that keeps answering. Both are ceilings, not
 * targets: an export that hits one still succeeds and says it was truncated.
 */
export interface ExportBounds {
  /** Hard cap on retained events. The newest are kept when it bites. */
  maxEvents: number;
  /** Hard cap on REQ round-trips, independent of how many events land. */
  maxPages: number;
}

export const DEFAULT_BOUNDS: ExportBounds = {
  maxEvents: 20_000,
  maxPages: 400,
};

/** Why an export stopped. Only "complete" means the history ran out. */
export type ExportStopReason =
  | "complete"
  | "max-events"
  | "max-pages"
  | "cancelled";

/** One page's worth of decisions: what to keep, and where to go next. */
export interface PagePlan {
  /** New events from this page, ascending by created_at, already deduped. */
  accepted: SignedNostrEvent[];
  /** `until` for the next REQ, or null when there is no next REQ. */
  nextUntil: number | null;
  /** True when this was the last page. */
  done: boolean;
  /** Set only when `done`. */
  reason: ExportStopReason | null;
  /**
   * A full page whose events all share one `created_at`. `until` must still
   * step below it to make progress, so events at that second beyond the page
   * size are unreachable — the export reports this rather than hiding it.
   */
  sameTimestampPage: boolean;
}

/**
 * Filter for one export page.
 *
 * `until` is inclusive in NIP-01, so callers step it below the oldest event
 * already taken — the same discipline `olderPageFilter` uses for scroll-up.
 * A null `until` asks for the newest page.
 */
export function exportPageFilter(
  channelId: string,
  kinds: number[],
  until: number | null,
  limit: number = EXPORT_PAGE_SIZE,
): NostrFilter {
  const filter: NostrFilter = {
    kinds: [...kinds].sort((a, b) => a - b),
    "#h": [channelId],
    limit,
  };
  if (until !== null) {
    filter.until = Math.max(0, until);
  }
  return filter;
}

function ascending(a: SignedNostrEvent, b: SignedNostrEvent): number {
  if (a.created_at !== b.created_at) {
    return a.created_at - b.created_at;
  }
  // Stable, deterministic ordering inside one second so two exports of the
  // same history are byte-identical.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Decide what to keep from a page and whether to ask for another.
 *
 * Pure: `seen` is read, never written — the caller owns that set, so a
 * cancelled or retried page cannot poison it.
 */
export function planPage(input: {
  /** Raw events the relay returned for this page, in any order. */
  page: SignedNostrEvent[];
  /** Event ids already accepted by earlier pages. */
  seen: ReadonlySet<string>;
  /** How many events earlier pages already accepted. */
  totalAccepted: number;
  /** 0-based index of the page just fetched. */
  pageIndex: number;
  /** The `limit` that was requested for this page. */
  pageSize: number;
  bounds: ExportBounds;
}): PagePlan {
  const { page, seen, totalAccepted, pageIndex, pageSize, bounds } = input;

  const withinPage = new Set<string>();
  const fresh: SignedNostrEvent[] = [];
  for (const event of page) {
    if (seen.has(event.id) || withinPage.has(event.id)) {
      continue;
    }
    withinPage.add(event.id);
    fresh.push(event);
  }
  fresh.sort(ascending);

  const remaining = Math.max(0, bounds.maxEvents - totalAccepted);
  const overflowed = fresh.length > remaining;
  // Truncation keeps the NEWEST events: a partial archive of recent history
  // is far more useful than a partial archive of the beginning of time.
  const accepted = overflowed ? fresh.slice(fresh.length - remaining) : fresh;

  const sameTimestampPage =
    page.length >= pageSize &&
    page.length > 1 &&
    page.every((event) => event.created_at === page[0].created_at);

  if (overflowed || totalAccepted + accepted.length >= bounds.maxEvents) {
    return {
      accepted,
      nextUntil: null,
      done: true,
      reason: "max-events",
      sameTimestampPage,
    };
  }

  // A short page means the relay had nothing older to give under this
  // window — the same "history exhausted" signal scroll-up pagination uses.
  if (page.length < pageSize) {
    return {
      accepted,
      nextUntil: null,
      done: true,
      reason: "complete",
      sameTimestampPage,
    };
  }

  if (pageIndex + 1 >= bounds.maxPages) {
    return {
      accepted,
      nextUntil: null,
      done: true,
      reason: "max-pages",
      sameTimestampPage,
    };
  }

  let oldest = page[0].created_at;
  for (const event of page) {
    if (event.created_at < oldest) {
      oldest = event.created_at;
    }
  }
  const nextUntil = oldest - 1;
  if (nextUntil < 0) {
    return {
      accepted,
      nextUntil: null,
      done: true,
      reason: "complete",
      sameTimestampPage,
    };
  }

  return {
    accepted,
    nextUntil,
    done: false,
    reason: null,
    sameTimestampPage,
  };
}

/** Human sentence for a stop reason, for the settings card and the file header. */
export function describeStopReason(
  reason: ExportStopReason,
  bounds: ExportBounds,
): string {
  switch (reason) {
    case "complete":
      return "Complete — the relay had no older events.";
    case "max-events":
      return `Truncated at the ${bounds.maxEvents.toLocaleString()}-event ceiling; the newest events were kept.`;
    case "max-pages":
      return `Truncated at the ${bounds.maxPages}-page ceiling; the newest events were kept.`;
    case "cancelled":
      return "Cancelled — the events already collected were kept.";
  }
}
