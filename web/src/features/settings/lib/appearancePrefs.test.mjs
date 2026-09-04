import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  APPEARANCE_PREFERENCES,
  CONVERSATION_DENSITY_PREFERENCE,
  FONT_SIZE_PREFERENCE,
  LINK_PREVIEW_STYLE_PREFERENCE,
  PROMINENT_ACTIVE_TAB_PREFERENCE,
  THREAD_LAYOUT_PREFERENCE,
  parsePreference,
} from "./appearancePrefs.ts";

/**
 * Storage keys are pinned to LITERALS, never to each other or to the spec they
 * came from. The point of the assertion is that a typo or a rename diverges
 * from the desktop client's keys, and an expectation phrased as
 * `FONT_SIZE_PREFERENCE.storageKey` would move with the bug.
 */
test("storage keys match the desktop client's, character for character", () => {
  assert.equal(FONT_SIZE_PREFERENCE.storageKey, "buzz.appearance.fontSize");
  assert.equal(
    CONVERSATION_DENSITY_PREFERENCE.storageKey,
    "buzz.appearance.conversationDensity",
  );
  assert.equal(
    LINK_PREVIEW_STYLE_PREFERENCE.storageKey,
    "buzz.appearance.linkPreviewStyle",
  );
  // Not "buzz.appearance.*" — the desktop files this one under channels.
  assert.equal(
    THREAD_LAYOUT_PREFERENCE.storageKey,
    "buzz.channels.threadViewMode",
  );
  // Nor under "buzz.appearance.*": the desktop's ThemeProvider files this one
  // as a theme preference, and matching its spelling is what lets the two
  // clients read the same stored choice.
  assert.equal(
    PROMINENT_ACTIVE_TAB_PREFERENCE.storageKey,
    "buzz-prominent-active-tab",
  );
});

test("root attribute names match the ones the stylesheet selects on", () => {
  assert.equal(FONT_SIZE_PREFERENCE.attribute, "data-font-size");
  assert.equal(
    CONVERSATION_DENSITY_PREFERENCE.attribute,
    "data-conversation-density",
  );
  assert.equal(
    LINK_PREVIEW_STYLE_PREFERENCE.attribute,
    "data-link-preview-style",
  );
  assert.equal(THREAD_LAYOUT_PREFERENCE.attribute, "data-thread-layout");
  assert.equal(
    PROMINENT_ACTIVE_TAB_PREFERENCE.attribute,
    "data-prominent-active-tab",
  );
});

/**
 * The type-scale and density preferences are carried entirely by CSS — no
 * component reads them — so this checks the stylesheet actually has a rule for
 * every non-default value. It is a text check over globals.css and therefore
 * proves only that the selector exists, not that it renders; the browser pass
 * is what proves the rendering. Its value is catching the specific failure
 * where a value is added or renamed here and the stylesheet is not touched,
 * which no other automated check in this repo would see.
 */
test("globals.css carries a rule for every non-default font-size and density", () => {
  const css = readFileSync(
    fileURLToPath(
      new URL("../../../shared/styles/globals.css", import.meta.url),
    ),
    "utf8",
  );
  const expected = [
    ':root[data-font-size="smaller"]',
    ':root[data-font-size="larger"]',
    ':root[data-conversation-density="compact"]',
    ':root[data-conversation-density="spacious"]',
    ':root[data-prominent-active-tab="true"]',
  ];
  for (const selector of expected) {
    assert.ok(css.includes(selector), `globals.css is missing ${selector}`);
  }
});

test("the 13 / 14 / 15px contract stays in the stylesheet, as a ratio", () => {
  const css = readFileSync(
    fileURLToPath(
      new URL("../../../shared/styles/globals.css", import.meta.url),
    ),
    "utf8",
  );
  // Ratios of the virtual type rem, not px literals: a px value here would
  // freeze against Cmd +/- zoom, which is the regression PR #891 shipped.
  assert.ok(css.includes("--buzz-type-scale: calc(13 / 14)"));
  assert.ok(css.includes("--buzz-type-scale: calc(15 / 14)"));
  assert.ok(!/data-font-size="(smaller|larger)"\][^}]*\dpx/.test(css));
});

test("parsePreference keeps legal values", () => {
  assert.equal(parsePreference(FONT_SIZE_PREFERENCE, "smaller"), "smaller");
  assert.equal(parsePreference(FONT_SIZE_PREFERENCE, "larger"), "larger");
  assert.equal(
    parsePreference(CONVERSATION_DENSITY_PREFERENCE, "spacious"),
    "spacious",
  );
  assert.equal(parsePreference(THREAD_LAYOUT_PREFERENCE, "focus"), "focus");
});

test("parsePreference falls back for absent, corrupt, or foreign values", () => {
  assert.equal(parsePreference(FONT_SIZE_PREFERENCE, null), "default");
  assert.equal(parsePreference(FONT_SIZE_PREFERENCE, undefined), "default");
  assert.equal(parsePreference(FONT_SIZE_PREFERENCE, ""), "default");
  // Case matters: the value lands in an attribute CSS matches exactly.
  assert.equal(parsePreference(FONT_SIZE_PREFERENCE, "Larger"), "default");
  // A value that is legal for a DIFFERENT preference must not be accepted —
  // this is the assertion that fails if the specs ever share one value list.
  assert.equal(parsePreference(FONT_SIZE_PREFERENCE, "spacious"), "default");
  assert.equal(
    parsePreference(CONVERSATION_DENSITY_PREFERENCE, "larger"),
    "comfortable",
  );
  assert.equal(parsePreference(THREAD_LAYOUT_PREFERENCE, "rich"), "split");
  // The boolean-shaped one is stored as the desktop's "true"/"false" strings,
  // so anything else — including a real boolean that lost its quotes on the
  // way through storage — falls back to off rather than reaching the DOM.
  assert.equal(
    parsePreference(PROMINENT_ACTIVE_TAB_PREFERENCE, "true"),
    "true",
  );
  assert.equal(
    parsePreference(PROMINENT_ACTIVE_TAB_PREFERENCE, "TRUE"),
    "false",
  );
  assert.equal(parsePreference(PROMINENT_ACTIVE_TAB_PREFERENCE, "1"), "false");
  assert.equal(parsePreference(PROMINENT_ACTIVE_TAB_PREFERENCE, null), "false");
});

/**
 * Defaults are asserted as literals AND as "not the first legal value",
 * because two of the four are not first: a `defaultValue: values[0]`
 * refactor would look correct and would silently move everyone from Comfy to
 * Compact and from Split to Focus.
 */
test("defaults are the desktop's, and are not merely the first option", () => {
  assert.equal(FONT_SIZE_PREFERENCE.defaultValue, "default");
  assert.equal(CONVERSATION_DENSITY_PREFERENCE.defaultValue, "comfortable");
  assert.equal(LINK_PREVIEW_STYLE_PREFERENCE.defaultValue, "compact");
  assert.equal(THREAD_LAYOUT_PREFERENCE.defaultValue, "split");
  // Off by default, exactly as the desktop's DEFAULT_PROMINENT_ACTIVE_TAB.
  assert.equal(PROMINENT_ACTIVE_TAB_PREFERENCE.defaultValue, "false");

  assert.notEqual(
    CONVERSATION_DENSITY_PREFERENCE.defaultValue,
    CONVERSATION_DENSITY_PREFERENCE.values[0],
  );
  assert.notEqual(
    THREAD_LAYOUT_PREFERENCE.defaultValue,
    THREAD_LAYOUT_PREFERENCE.values[0],
  );
});

test("every default is one of its own legal values", () => {
  assert.equal(APPEARANCE_PREFERENCES.length, 5);
  for (const spec of APPEARANCE_PREFERENCES) {
    assert.ok(
      spec.values.includes(spec.defaultValue),
      `${spec.storageKey} defaults to a value it does not allow`,
    );
  }
});

test("the registry lists each preference once, with distinct keys", () => {
  const keys = APPEARANCE_PREFERENCES.map((spec) => spec.storageKey);
  const attributes = APPEARANCE_PREFERENCES.map((spec) => spec.attribute);
  assert.equal(new Set(keys).size, 5);
  assert.equal(new Set(attributes).size, 5);
  // The store's initializer indexes by attribute; a preference missing from
  // the registry is a preference that is never applied at first paint.
  assert.deepEqual([...attributes].sort(), [
    "data-conversation-density",
    "data-font-size",
    "data-link-preview-style",
    "data-prominent-active-tab",
    "data-thread-layout",
  ]);
});
