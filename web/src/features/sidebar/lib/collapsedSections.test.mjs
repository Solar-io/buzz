import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCollapsed,
  loadCollapsedSections,
  saveCollapsedSections,
  toggleSection,
} from "./collapsedSections.ts";

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

test("an untouched section defaults to expanded", () => {
  // The list-of-collapsed-ids shape exists for this: a section nobody has
  // touched is absent, so a newly added section shows rather than hides.
  assert.equal(isCollapsed([], "channels"), false);
  assert.equal(isCollapsed(["dms"], "channels"), false);
});

test("toggleSection collapses then expands", () => {
  const once = toggleSection([], "channels");
  assert.deepEqual(once, ["channels"]);
  assert.deepEqual(toggleSection(once, "channels"), []);
});

test("toggleSection does not mutate its input", () => {
  // The list is React state; mutating it in place would skip a re-render.
  const before = ["dms"];
  const after = toggleSection(before, "channels");
  assert.deepEqual(before, ["dms"]);
  assert.notEqual(after, before);
});

test("toggling one section leaves the others alone", () => {
  const result = toggleSection(["channels", "forums"], "forums");
  assert.deepEqual(result, ["channels"]);
});

test("a round-trip through storage preserves the collapsed set", () => {
  const storage = fakeStorage();
  saveCollapsedSections(["channels", "dms"], storage);
  assert.deepEqual(loadCollapsedSections(storage), ["channels", "dms"]);
});

test("a missing key loads as nothing collapsed", () => {
  assert.deepEqual(loadCollapsedSections(fakeStorage()), []);
});

test("corrupt storage loads as nothing collapsed rather than throwing", () => {
  // Showing everything is the safe failure: hiding sections because JSON
  // failed to parse would look like data loss.
  assert.deepEqual(
    loadCollapsedSections(
      fakeStorage({
        "buzz.collapsed-sections.v1": "{not json",
      }),
    ),
    [],
  );
});

test("a non-array payload loads as nothing collapsed", () => {
  assert.deepEqual(
    loadCollapsedSections(
      fakeStorage({
        "buzz.collapsed-sections.v1": '{"channels":true}',
      }),
    ),
    [],
  );
});

test("non-string entries are dropped rather than trusted", () => {
  assert.deepEqual(
    loadCollapsedSections(
      fakeStorage({
        "buzz.collapsed-sections.v1": '["channels",42,null,"dms"]',
      }),
    ),
    ["channels", "dms"],
  );
});

test("absent storage is tolerated in both directions", () => {
  assert.deepEqual(loadCollapsedSections(undefined), []);
  assert.doesNotThrow(() => saveCollapsedSections(["channels"], undefined));
});
