import assert from "node:assert/strict";
import test from "node:test";

import { fileCommentsFilter, shelfFilters } from "./shelfQuery.ts";

test("the Shelf REQ: kind 9, #t shelf pushed down, every channel in #h, 128 a filter", () => {
  const ids = Array.from(
    { length: 130 },
    (_, index) => `ch-${String(index).padStart(3, "0")}`,
  );
  const filters = shelfFilters([...ids, ids[0], ""]);
  assert.equal(filters.length, 2);
  assert.deepEqual(filters[0].kinds, [9]);
  assert.deepEqual(filters[0]["#t"], ["shelf"]);
  assert.equal(filters[0]["#h"].length, 128);
  assert.deepEqual(filters[1]["#h"], ["ch-128", "ch-129"]);
  assert.equal(filters[0].limit, 200);
  // History AND live: no `since`, and never a filter without #h (gotcha 11).
  for (const filter of filters) {
    assert.equal(filter.since, undefined);
    assert.ok(filter["#h"].length > 0);
  }
  assert.deepEqual(shelfFilters([]), []);
});

test("comments: replies that reference the share, scoped to its channel", () => {
  assert.deepEqual(fileCommentsFilter({ id: "s", channelId: "c" }), {
    kinds: [9],
    "#e": ["s"],
    "#h": ["c"],
    limit: 200,
  });
});
