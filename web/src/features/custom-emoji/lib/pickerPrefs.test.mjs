import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PREFS,
  MAX_RECENT,
  parsePickerPrefs,
  PICKER_PREFS_KEY,
  pushRecent,
} from "./pickerPrefs.ts";

test("the storage key is the versioned literal, so a format change is a new key", () => {
  assert.equal(PICKER_PREFS_KEY, "buzz:emoji-picker:v1");
});

test("missing, corrupt, or wrongly-typed storage yields defaults", () => {
  assert.deepEqual(parsePickerPrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePickerPrefs("not json"), DEFAULT_PREFS);
  assert.deepEqual(parsePickerPrefs("[1,2,3]").recent, []);
  assert.deepEqual(parsePickerPrefs('"a string"'), DEFAULT_PREFS);
});

test("an out-of-range or fractional tone is clamped to a real swatch", () => {
  assert.equal(parsePickerPrefs('{"tone":9}').tone, 5);
  assert.equal(parsePickerPrefs('{"tone":-3}').tone, 0);
  assert.equal(parsePickerPrefs('{"tone":2.5}').tone, 0);
  assert.equal(parsePickerPrefs('{"tone":"3"}').tone, 0);
  assert.equal(parsePickerPrefs('{"tone":4}').tone, 4);
});

test("non-string and empty recents are dropped, and the list is capped", () => {
  const raw = JSON.stringify({
    recent: [
      "a",
      1,
      null,
      "",
      "b",
      ...Array.from({ length: 40 }, (_, i) => `x${i}`),
    ],
  });
  const prefs = parsePickerPrefs(raw);
  assert.equal(prefs.recent.length, MAX_RECENT);
  assert.deepEqual(prefs.recent.slice(0, 2), ["a", "b"]);
});

test("pushRecent moves a pick to the front and dedupes it", () => {
  assert.deepEqual(pushRecent(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(pushRecent(["a", "b"], "c"), ["c", "a", "b"]);
});

test("pushRecent caps the list at the newest entries", () => {
  const full = Array.from({ length: MAX_RECENT }, (_, i) => `e${i}`);
  const next = pushRecent(full, "new");
  assert.equal(next.length, MAX_RECENT);
  assert.equal(next[0], "new");
  assert.ok(!next.includes(`e${MAX_RECENT - 1}`), "the oldest fell off");
});

test("re-picking the current head, or picking nothing, returns the same array", () => {
  const recent = ["a", "b"];
  assert.equal(pushRecent(recent, "a"), recent);
  assert.equal(pushRecent(recent, ""), recent);
});

test("a custom emoji's recent entry is its :shortcode: token", () => {
  // Recents replay the inserted string, so a custom pick must round-trip as
  // the token the composer inserts, not as a glyph it has no way to produce.
  assert.deepEqual(pushRecent([], ":shipit:"), [":shipit:"]);
});
