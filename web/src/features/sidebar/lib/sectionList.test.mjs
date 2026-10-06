import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIDEBAR_LIST_OPTIONS,
  sectionHeaderState,
  truncateSection,
} from "./sectionList.ts";

// Items are plain strings; expectations are hardcoded, never derived from the
// limit or the options under test.
const letters = (n) => "abcdefghijklmnopqrstuvwxyz".slice(0, n).split("");

test("the design's default: 6 visible rows", () => {
  assert.equal(SIDEBAR_LIST_OPTIONS.visibleItems, 6);
});

test("a list at or under the limit shows whole, no more row", () => {
  const r = truncateSection({ items: letters(6), limit: 6, expanded: false });
  assert.deepEqual(r.shown, ["a", "b", "c", "d", "e", "f"]);
  assert.equal(r.hasMoreRow, false);
});

test("one-over rule: 7 items with limit 6 show all 7, no '1 more'", () => {
  const r = truncateSection({ items: letters(7), limit: 6, expanded: false });
  assert.deepEqual(r.shown, ["a", "b", "c", "d", "e", "f", "g"]);
  assert.equal(r.hasMoreRow, false);
  assert.equal(r.hiddenCount, 0);
});

test("two over truncates to the limit with an 'N more' row", () => {
  const r = truncateSection({ items: letters(8), limit: 6, expanded: false });
  assert.deepEqual(r.shown, ["a", "b", "c", "d", "e", "f"]);
  assert.equal(r.hasMoreRow, true);
  assert.equal(r.hiddenCount, 2);
  assert.equal(r.moreLabel, "2 more");
});

test("expanded shows everything and the row reads 'Show less'", () => {
  const r = truncateSection({ items: letters(10), limit: 6, expanded: true });
  assert.equal(r.shown.length, 10);
  assert.equal(r.hasMoreRow, true);
  assert.equal(r.moreLabel, "Show less");
});

test("a selected item past the cutoff is appended and not counted as hidden", () => {
  const r = truncateSection({
    items: letters(14),
    limit: 6,
    expanded: false,
    isSelected: (item) => item === "k",
  });
  assert.deepEqual(r.shown, ["a", "b", "c", "d", "e", "f", "k"]);
  assert.equal(r.moreLabel, "7 more");
});

test("a selected item inside the cutoff is not duplicated", () => {
  const r = truncateSection({
    items: letters(14),
    limit: 6,
    expanded: false,
    isSelected: (item) => item === "c",
  });
  assert.deepEqual(r.shown, ["a", "b", "c", "d", "e", "f"]);
  assert.equal(r.moreLabel, "8 more");
});

test("an open header shows no count and no dot", () => {
  assert.deepEqual(
    sectionHeaderState({
      items: ["x", "Y"],
      collapsed: false,
      isUnread: (s) => s === "Y",
    }),
    { count: null, unreadDot: false },
  );
});

test("a collapsed header shows the UNREAD count and a dot when anything is unread (QA #18), else the item count", () => {
  assert.deepEqual(
    sectionHeaderState({
      items: ["x", "Y", "z", "W"],
      collapsed: true,
      isUnread: (s) => s === s.toUpperCase(),
      count: "unread",
    }),
    { count: 2, unreadDot: true },
  );
  // The nav disclosures (Forums / Links) keep counting their items.
  assert.deepEqual(
    sectionHeaderState({
      items: ["x", "Y", "z", "W"],
      collapsed: true,
      isUnread: (s) => s === s.toUpperCase(),
    }),
    { count: 4, unreadDot: true },
  );
  assert.deepEqual(
    sectionHeaderState({
      items: ["x", "z"],
      collapsed: true,
      isUnread: () => false,
    }),
    { count: 2, unreadDot: false },
  );
});
