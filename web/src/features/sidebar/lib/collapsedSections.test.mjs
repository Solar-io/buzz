import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_COLLAPSED_SECTIONS,
  isCollapsed,
  NAV_FORUMS_ID,
  NAV_LINKS_ID,
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
  // "dms" defaults open, so expanding it just drops its id. (A
  // default-collapsed section expands to an open marker; see below.)
  const result = toggleSection(["channels", "dms"], "dms");
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

test("the Forums and Links nav rows start collapsed for a viewer who never touched them", () => {
  // Sam, 2026-09-30: both are nav buttons under Terminal that start folded.
  // The ids are spelled out, not read from the module's constants, so a
  // renamed or dropped default fails here instead of agreeing with itself.
  assert.deepEqual([...DEFAULT_COLLAPSED_SECTIONS].sort(), [
    "nav:forums",
    "nav:links",
  ]);
  assert.equal(NAV_FORUMS_ID, "nav:forums");
  assert.equal(NAV_LINKS_ID, "nav:links");
  assert.equal(isCollapsed([], "nav:forums"), true);
  assert.equal(isCollapsed([], "nav:links"), true);
  assert.equal(isCollapsed([], "channels"), false);
  assert.equal(isCollapsed([], "dms"), false);
  assert.equal(isCollapsed([], "starred"), false);
});

test("a device that had OPENED the old Forums / Links sections still starts the nav rows folded", () => {
  // The old section ids defaulted collapsed too, so a device that opened
  // them carries `open:` markers. Those must not leak into the nav rows.
  const legacy = ["open:forums", "open:links", "channels"];
  assert.equal(isCollapsed(legacy, "nav:forums"), true);
  assert.equal(isCollapsed(legacy, "nav:links"), true);
  assert.equal(isCollapsed(legacy, "channels"), true);
});

test("opening a default-collapsed section persists as an open marker", () => {
  const opened = toggleSection([], "nav:forums");
  assert.deepEqual(opened, ["open:nav:forums"]);
  assert.equal(isCollapsed(opened, "nav:forums"), false);
  const closed = toggleSection(opened, "nav:forums");
  assert.deepEqual(closed, ["nav:forums"]);
  assert.equal(isCollapsed(closed, "nav:forums"), true);
  assert.equal(
    isCollapsed(toggleSection(closed, "nav:forums"), "nav:forums"),
    false,
  );
});

test("a bare id still means collapsed, and toggling it opens it", () => {
  // The list's original shape: a bare id means collapsed. It must stay
  // collapsed, and toggling it must open it rather than land back on the
  // default.
  assert.equal(isCollapsed(["nav:forums"], "nav:forums"), true);
  assert.equal(isCollapsed(["channels"], "channels"), true);
  assert.equal(
    isCollapsed(toggleSection(["nav:forums"], "nav:forums"), "nav:forums"),
    false,
  );
});

test("an open marker survives a storage round-trip", () => {
  const storage = fakeStorage();
  saveCollapsedSections(toggleSection([], "nav:links"), storage);
  assert.equal(isCollapsed(loadCollapsedSections(storage), "nav:links"), false);
});
