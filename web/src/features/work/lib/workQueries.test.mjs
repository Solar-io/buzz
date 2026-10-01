import assert from "node:assert/strict";
import { test } from "node:test";

import { taskStatusFilters } from "./workQueries.ts";

test("30624 REQs carry #h (live fan-out) in 128-channel chunks, 24 h back", () => {
  const ids = Array.from(
    { length: 130 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const filters = taskStatusFilters(ids, 1_000_000);
  assert.equal(filters.length, 2, "130 channels → two REQs");
  for (const filter of filters) {
    // Hardcoded, not the constant: the wire kind is the contract.
    assert.deepEqual(filter.kinds, [30624]);
    assert.equal(filter.since, 1_000_000 - 86_400);
    // The relay never fans a channel-scoped event out to an #h-less REQ
    // (AGENTS.md gotcha 11): without this the tab loads, then goes deaf.
    assert.ok(Array.isArray(filter["#h"]) && filter["#h"].length > 0);
  }
  assert.deepEqual(
    filters.flatMap((filter) => filter["#h"]),
    ids,
  );
  assert.deepEqual(taskStatusFilters([], 1_000_000), []);
});
