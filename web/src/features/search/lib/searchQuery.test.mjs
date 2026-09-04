import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSearchOperators } from "./parseSearchOperators.ts";
import {
  MIN_SCOPED_SEARCH_QUERY_LENGTH,
  MIN_SEARCH_QUERY_LENGTH,
  buildSearchFilter,
  dedupeHits,
  minimumQueryLength,
  searchHitFromEvent,
  sortHits,
} from "./searchQuery.ts";

const KINDS = [9, 40002];
const CHANNEL = "11111111-2222-3333-4444-555555555555";
const AUTHOR = "a".repeat(64);

function filterFor(query, overrides = {}) {
  return buildSearchFilter({
    parsed: parseSearchOperators(query),
    kinds: KINDS,
    ...overrides,
  });
}

test("the minimum query length drops when the search is scoped", () => {
  assert.equal(MIN_SEARCH_QUERY_LENGTH, 2);
  assert.equal(MIN_SCOPED_SEARCH_QUERY_LENGTH, 1);
  assert.equal(minimumQueryLength(null), 2);
  assert.equal(minimumQueryLength(CHANNEL), 1);
});

test("a one-character query searches a channel but not the world", () => {
  assert.equal(filterFor("x"), null);
  assert.notEqual(filterFor("x", { channelId: CHANNEL }), null);
});

test("kinds are always sent — an omitted kinds list is a 403", () => {
  const filter = filterFor("deploy");
  assert.deepEqual(filter.kinds, KINDS);
  assert.equal(
    buildSearchFilter({ parsed: parseSearchOperators("deploy"), kinds: [] }),
    null,
  );
});

test("a channel scope becomes #h", () => {
  const filter = filterFor("deploy", { channelId: CHANNEL });
  assert.deepEqual(filter["#h"], [CHANNEL]);
  assert.equal(filterFor("deploy")["#h"], undefined);
});

test("a resolved author becomes a lowercased authors filter", () => {
  const filter = filterFor("deploy", { author: AUTHOR.toUpperCase() });
  assert.deepEqual(filter.authors, [AUTHOR]);
});

test("date operators become since / until and leave the text clean", () => {
  const filter = filterFor("after:2025-03-01 before:2025-03-05 deploy");
  assert.equal(filter.search, "deploy");
  assert.equal(typeof filter.since, "number");
  assert.equal(typeof filter.until, "number");
  assert.ok(filter.until > filter.since);
});

test("an unresolved operator refuses to search rather than widening", () => {
  // The whole point: `from:nobody` must return nothing, not everything.
  assert.equal(filterFor("deploy", { hasUnresolvedOperator: true }), null);
});

test("a date operator alone is not a query", () => {
  assert.equal(filterFor("after:2025-03-01"), null);
});

test("operators are stripped from the text the relay searches", () => {
  const filter = filterFor("from:@ada in:#general deploy rollback", {
    channelId: CHANNEL,
    author: AUTHOR,
  });
  assert.equal(filter.search, "deploy rollback");
});

test("searchHitFromEvent requires an h tag", () => {
  const event = {
    id: "e1",
    pubkey: AUTHOR,
    created_at: 10,
    content: "hello",
    tags: [["h", CHANNEL]],
  };
  assert.deepEqual(searchHitFromEvent(event), {
    id: "e1",
    channelId: CHANNEL,
    authorPubkey: AUTHOR,
    createdAt: 10,
    content: "hello",
  });
  assert.equal(searchHitFromEvent({ ...event, tags: [["e", "x"]] }), null);
});

test("hits are newest-first and de-duplicated by event id", () => {
  const hits = [
    {
      id: "a",
      channelId: CHANNEL,
      authorPubkey: AUTHOR,
      createdAt: 1,
      content: "",
    },
    {
      id: "b",
      channelId: CHANNEL,
      authorPubkey: AUTHOR,
      createdAt: 3,
      content: "",
    },
    {
      id: "a",
      channelId: CHANNEL,
      authorPubkey: AUTHOR,
      createdAt: 1,
      content: "",
    },
  ];
  assert.deepEqual(
    sortHits(dedupeHits(hits)).map((hit) => hit.id),
    ["b", "a"],
  );
  assert.equal(dedupeHits(hits).length, 2);
});
