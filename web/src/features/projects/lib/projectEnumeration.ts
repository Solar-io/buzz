/**
 * Exhaustive enumeration for the NIP-MP fold.
 *
 * The fold in `docs/nips/NIP-MP.md` is only correct over the *complete* set of
 * heads: miss one repository and a project renders a member as "unavailable"
 * that plainly exists; miss one project and a claimed repository wrongly
 * reappears as its own card. So a fixed `limit` is forbidden — the listing
 * pages until the relay is exhausted, or says out loud that it could not.
 *
 * The spec's Pagination section defines two conformant modes, and Buzz offers
 * a different one per transport:
 *
 * - **Mode 1, composite cursor** — keyset over `(created_at, id)`, resolved as
 *   `created_at < until OR (created_at = until AND id > before_id)`
 *   (`crates/buzz-db/src/event.rs`). Exhaustive. Buzz exposes it on the
 *   NIP-98-authenticated HTTP bridge (`POST /query`,
 *   `crates/buzz-relay/src/api/bridge.rs`) and nowhere else.
 * - **Mode 2, `until` only** — the websocket REQ path silently discards
 *   `before_id` (the REQ filter deserializer drops unknown fields), so a
 *   websocket client gets no id tiebreak and must drain each boundary second
 *   explicitly. A second holding at least a full page is undrainable, and the
 *   spec's step 3 is explicit about what to do then: mark the collection
 *   possibly incomplete and carry on — never present it as complete, and never
 *   stall.
 *
 * Both modes return {@link EnumerationResult} so the caller cannot accidentally
 * treat a truncated collection as a whole one; the listing renders the mark.
 *
 * **Query shapes matter as much as the cursor.** The relay applies `#a` (and
 * `#t`) *after* the SQL `LIMIT` — `filter_fully_pushable` in
 * `crates/buzz-relay/src/handlers/req.rs` lists which constraints reach SQL,
 * and any other generic tag does not — so an `#a`-scoped query can come back
 * short while older matches sit beyond the limited window, and its short page
 * proves nothing. Every enumeration here is therefore issued by `kinds` (and
 * `authors`/`#e`, which are pushed), with the repository coordinate matched
 * client-side.
 */

import type { ProjectSourceEvent } from "./projectModels.ts";

/** Extra scoping merged into every page. Only pre-limit constraints belong here. */
export type EnumerationExtraFilter = {
  authors?: string[];
  "#e"?: string[];
};

export type EnumerationPageFilter = EnumerationExtraFilter & {
  kinds: number[];
  limit: number;
  since?: number;
  until?: number;
  /** Mode 1 only — the id half of the composite cursor. */
  before_id?: string;
};

export type FetchEnumerationPage = (
  filter: EnumerationPageFilter,
) => Promise<ProjectSourceEvent[]>;

export type EnumerationResult = {
  events: ProjectSourceEvent[];
  /**
   * True when the relay could not be drained — a boundary second larger than
   * one page. The collection is a subset and MUST be presented as such.
   */
  possiblyIncomplete: boolean;
};

function assertPageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error("Enumeration page size must be a positive integer.");
  }
}

/**
 * Mode 1 — composite `(created_at, id)` keyset. Each page resumes exactly
 * where the last ended, so events sharing a `created_at` are never skipped and
 * never re-read, and a short page is an unambiguous end signal.
 *
 * Requires a transport that honours `before_id`: on Buzz that is the HTTP
 * bridge, not the websocket.
 */
export async function enumerateEventsComposite(
  fetchPage: FetchEnumerationPage,
  kinds: number[],
  pageSize: number,
  extraFilter?: EnumerationExtraFilter,
  signal?: AbortSignal,
): Promise<EnumerationResult> {
  assertPageSize(pageSize);
  const eventsById = new Map<string, ProjectSourceEvent>();
  let cursor: { until: number; before_id: string } | undefined;

  for (;;) {
    signal?.throwIfAborted();
    const page = await fetchPage({
      ...extraFilter,
      kinds,
      limit: pageSize,
      ...(cursor ?? {}),
    });
    for (const event of page) eventsById.set(event.id, event);
    if (page.length < pageSize) {
      return { events: [...eventsById.values()], possiblyIncomplete: false };
    }
    // The relay sorts `(created_at DESC, id ASC)`, so the page's last row is
    // the cursor. Recompute it here rather than trusting arrival order.
    const last = page.reduce((oldest, event) =>
      event.created_at < oldest.created_at ||
      (event.created_at === oldest.created_at && event.id > oldest.id)
        ? event
        : oldest,
    );
    if (
      cursor &&
      cursor.until === last.created_at &&
      cursor.before_id === last.id
    ) {
      // The cursor did not advance: the transport is ignoring `before_id`
      // (the websocket does exactly this). Stop rather than loop forever.
      return { events: [...eventsById.values()], possiblyIncomplete: true };
    }
    cursor = { until: last.created_at, before_id: last.id };
  }
}

/**
 * Mode 2 — `until` only, with the boundary-second drain.
 *
 * Neither naive step is safe: `until = oldest - 1` skips every unread event in
 * that second, and `until = oldest` re-requests the whole bucket forever. So
 * after each full page the boundary second is queried exactly
 * (`since == until == oldest`) and merged before stepping below it.
 *
 * A bucket that answers with a full page may hold more than the relay will
 * return at once. Per the spec that is not an error: the result is marked
 * possibly incomplete and enumeration continues past the second, because
 * gathering the older events beats stalling — but the mark is never cleared.
 */
export async function enumerateEventsUntilOnly(
  fetchPage: FetchEnumerationPage,
  kinds: number[],
  pageSize: number,
  extraFilter?: EnumerationExtraFilter,
  signal?: AbortSignal,
): Promise<EnumerationResult> {
  assertPageSize(pageSize);
  const eventsById = new Map<string, ProjectSourceEvent>();
  let possiblyIncomplete = false;
  let until: number | undefined;

  for (;;) {
    signal?.throwIfAborted();
    const page = await fetchPage({
      ...extraFilter,
      kinds,
      limit: pageSize,
      ...(until === undefined ? {} : { until }),
    });
    for (const event of page) eventsById.set(event.id, event);
    if (page.length < pageSize) {
      return { events: [...eventsById.values()], possiblyIncomplete };
    }

    const oldest = Math.min(...page.map((event) => event.created_at));
    signal?.throwIfAborted();
    const boundary = await fetchPage({
      ...extraFilter,
      kinds,
      limit: pageSize,
      since: oldest,
      until: oldest,
    });
    for (const event of boundary) eventsById.set(event.id, event);
    // Counted inclusively: a bucket holding exactly `limit` events is
    // indistinguishable from a larger one, and over-reporting doubt is safe.
    if (boundary.length >= pageSize) possiblyIncomplete = true;
    if (oldest <= 0) {
      return { events: [...eventsById.values()], possiblyIncomplete };
    }
    until = oldest - 1;
  }
}
