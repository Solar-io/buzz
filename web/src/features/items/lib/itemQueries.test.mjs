import assert from "node:assert/strict";
import test from "node:test";

import {
  ITEMS_MAX_EXTRA_PAGES,
  ITEMS_PAGE_LIMIT,
  itemsHistoryFilter,
  itemsLiveFilters,
  nextPageUntil,
  rostersFilter,
  sourceMessagesFilter,
} from "./itemQueries.ts";

const channel = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("history is one kinds-only REQ at the relay's max limit", () => {
  assert.equal(ITEMS_PAGE_LIMIT, 1000);
  assert.deepEqual(itemsHistoryFilter(), { kinds: [30623], limit: 1000 });
  assert.deepEqual(itemsHistoryFilter(1_759_000_000), {
    kinds: [30623],
    until: 1_759_000_000,
    limit: 1000,
  });
});

test("live items name every channel in #h, 128 to a filter, and never #p", () => {
  const ids = Array.from({ length: 300 }, (_, i) => channel(i));
  const filters = itemsLiveFilters([...ids, ids[0]], 500);
  assert.deepEqual(
    filters.map((filter) => filter["#h"].length),
    [128, 128, 44],
  );
  for (const filter of filters) {
    assert.deepEqual(filter.kinds, [30623]);
    assert.equal(filter.since, 500);
    assert.equal("#p" in filter, false);
    assert.equal("authors" in filter, false);
  }
  assert.deepEqual(
    new Set(filters.flatMap((filter) => filter["#h"])),
    new Set(ids),
  );
  assert.deepEqual(itemsLiveFilters([], 500), []);
});

test("paging continues only while pages come back full and older", () => {
  const full = ITEMS_PAGE_LIMIT;
  assert.equal(
    nextPageUntil({
      pageSize: 999,
      pageOldest: 10,
      previousUntil: null,
      pagesFetched: 0,
    }),
    null,
  );
  assert.equal(
    nextPageUntil({
      pageSize: full,
      pageOldest: 10,
      previousUntil: null,
      pagesFetched: 0,
    }),
    10,
  );
  assert.equal(
    nextPageUntil({
      pageSize: full,
      pageOldest: 5,
      previousUntil: 10,
      pagesFetched: 1,
    }),
    5,
  );
  // A full page with nothing older than the last cursor cannot make progress.
  assert.equal(
    nextPageUntil({
      pageSize: full,
      pageOldest: 10,
      previousUntil: 10,
      pagesFetched: 1,
    }),
    null,
  );
  assert.equal(
    nextPageUntil({
      pageSize: full,
      pageOldest: 1,
      previousUntil: 2,
      pagesFetched: ITEMS_MAX_EXTRA_PAGES + 1,
    }),
    null,
  );
});

test("source and roster reads are scoped by ids and kinds", () => {
  assert.deepEqual(sourceMessagesFilter(["b", "a", "b"]), {
    ids: ["a", "b"],
    kinds: [9, 40002, 45001, 45003],
  });
  assert.deepEqual(rostersFilter([channel(2), channel(1)]), {
    kinds: [39002],
    "#d": [channel(1), channel(2)],
    limit: 20,
  });
});
