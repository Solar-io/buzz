import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUZZ_BASE_THEME,
  BUZZ_DARK_BASE_THEME,
  BUZZ_DARK_THEME_NAME,
  BUZZ_THEME_NAME,
  SYNTAX_THEMES,
  getThemePair,
  isLightTheme,
  resolveShikiThemeName,
  resolveSystemTheme,
} from "./theme-loader.ts";

/**
 * The loader's resolution logic is what `followSystem` rides on, and every
 * one of these functions is a place where a wrong answer is invisible: you
 * get *a* theme, just not the right one. Vectors are chosen so that a broken
 * implementation returns a different, nameable value — not merely undefined.
 */

test("the Catppuccin family is available in all four variants", () => {
  // Catppuccin is the palette the web client is meant to ship; if the
  // registry ever loses it, the whole point of porting the engine is gone.
  for (const name of [
    "catppuccin-latte",
    "catppuccin-frappe",
    "catppuccin-macchiato",
    "catppuccin-mocha",
  ]) {
    assert.ok(
      SYNTAX_THEMES.includes(name),
      `${name} must be a selectable theme`,
    );
  }
});

test("light and dark themes are classified correctly", () => {
  // Hardcoded both ways: a stub returning a constant fails one side.
  assert.equal(isLightTheme("catppuccin-latte"), true);
  assert.equal(isLightTheme("github-light"), true);
  assert.equal(isLightTheme("catppuccin-mocha"), false);
  assert.equal(isLightTheme("github-dark"), false);
});

test("theme pairs map across polarity in both directions", () => {
  assert.equal(getThemePair("catppuccin-latte"), "catppuccin-mocha");
  assert.equal(getThemePair("catppuccin-mocha"), "catppuccin-latte");
  assert.equal(getThemePair("github-light"), "github-dark");
  assert.equal(getThemePair("github-dark"), "github-light");
});

test("a paired theme's partner has the opposite polarity", () => {
  // Structural invariant over the whole registry, so a single bad row in
  // THEME_PAIRS is caught even if no vector above names it.
  for (const name of SYNTAX_THEMES) {
    const pair = getThemePair(name);
    if (pair === null) continue;
    assert.notEqual(
      isLightTheme(name),
      isLightTheme(pair),
      `${name} and its pair ${pair} must differ in polarity`,
    );
  }
});

test("resolveSystemTheme keeps a theme that already matches the OS", () => {
  assert.equal(
    resolveSystemTheme("catppuccin-mocha", true),
    "catppuccin-mocha",
  );
  assert.equal(
    resolveSystemTheme("catppuccin-latte", false),
    "catppuccin-latte",
  );
});

test("resolveSystemTheme swaps to the partner when the OS disagrees", () => {
  // The discriminating case: a light selection under a dark OS must become
  // the DARK partner, named explicitly rather than "something different".
  assert.equal(
    resolveSystemTheme("catppuccin-latte", true),
    "catppuccin-mocha",
  );
  assert.equal(
    resolveSystemTheme("catppuccin-mocha", false),
    "catppuccin-latte",
  );
});

test("resolveSystemTheme leaves an unpaired theme alone", () => {
  // No partner means there is nothing honest to switch to; returning the
  // selection unchanged beats falling back to an unrelated default.
  const unpaired = SYNTAX_THEMES.find((name) => getThemePair(name) === null);
  assert.ok(unpaired, "expected at least one unpaired theme in the registry");
  assert.equal(resolveSystemTheme(unpaired, true), unpaired);
  assert.equal(resolveSystemTheme(unpaired, false), unpaired);
});

test("the Buzz aliases resolve to real Shiki bundles", () => {
  // Shiki throws on an unknown theme name, which would silently drop code
  // highlighting — the aliases are not bundled themes and must be mapped.
  assert.equal(resolveShikiThemeName(BUZZ_THEME_NAME), BUZZ_BASE_THEME);
  assert.equal(
    resolveShikiThemeName(BUZZ_DARK_THEME_NAME),
    BUZZ_DARK_BASE_THEME,
  );
  assert.equal(BUZZ_BASE_THEME, "github-light");
  assert.equal(BUZZ_DARK_BASE_THEME, "github-dark");
});

test("a non-alias theme name passes through resolveShikiThemeName intact", () => {
  assert.equal(resolveShikiThemeName("catppuccin-mocha"), "catppuccin-mocha");
});

test("the Buzz aliases have the polarity their names claim", () => {
  assert.equal(isLightTheme(BUZZ_THEME_NAME), true);
  assert.equal(isLightTheme(BUZZ_DARK_THEME_NAME), false);
});
