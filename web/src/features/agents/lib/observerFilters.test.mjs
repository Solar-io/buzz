import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHistoryFilter, liveObserverFilter } from "./observerFilters.ts";

// FIXED keys — expectations are hardcoded, never derived from the module.
const OWNER = "aa".repeat(32);
const AGENT = "bb".repeat(32);
const OTHER = "cc".repeat(32);

/**
 * The live page stays at the relay's ceiling. A WS REQ that omits `limit`
 * already defaults to DEFAULT_MAX_PAGE_LIMIT, so this pins the value rather
 * than changing it — and pins it against a later "tidy-up" that trims the
 * live page and silently starves the dots. Hardcoded rather than imported, so
 * changing LIVE_LIMIT cannot change its own expectation.
 */
test("the live filter asks for the relay's full page, explicitly", () => {
  const filter = liveObserverFilter(OWNER, 1_000_000);
  assert.equal(filter.limit, 1000);
});

test("the live filter is a bounded lookback, not all of history", () => {
  const filter = liveObserverFilter(OWNER, 1_000_000);
  assert.equal(filter.since, 999_700); // 1_000_000 - 300
  assert.deepEqual(filter.kinds, [24200]);
  assert.deepEqual(filter["#p"], [OWNER]);
  // The live REQ covers every agent at once: the sidebar dots and working
  // timers read from it, so it must NOT be author-scoped.
  assert.equal(filter.authors, undefined);
});

/**
 * The load-bearing assertion. One shared 1000-event page covered four of the
 * twenty-three agents with retained history on the dev relay, 714 slots going
 * to the busiest one. Author scoping is what gives a quiet agent its own page.
 */
test("history is scoped to one agent, so a chatty neighbour cannot crowd it out", () => {
  const filter = agentHistoryFilter(OWNER, AGENT);
  assert.deepEqual(filter.authors, [AGENT]);
  assert.ok(
    !filter.authors.includes(OTHER),
    "another agent's frames must not share this page",
  );
  assert.equal(filter.limit, 500);
});

test("history still carries #p, which is what the relay's p-gate authorizes", () => {
  // `p_gated_filters_authorized` (crates/buzz-relay/src/handlers/req.rs)
  // refuses a kind-24200 filter whose #p is absent or is someone else's.
  const filter = agentHistoryFilter(OWNER, AGENT);
  assert.deepEqual(filter["#p"], [OWNER]);
  assert.notDeepEqual(filter["#p"], [AGENT]);
});

test("history has no `since` — its whole job is the past the live window drops", () => {
  const filter = agentHistoryFilter(OWNER, AGENT);
  assert.equal(filter.since, undefined);
});
