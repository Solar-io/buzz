import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUZZ_BASE_THEME,
  BUZZ_DARK_BASE_THEME,
  BUZZ_DARK_THEME_NAME,
  BUZZ_THEME_NAME,
  SYNTAX_THEMES,
  getThemePair,
  extractThemeInfo,
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

test("the Buzz aliases seed interface chrome from the fleet palette", () => {
  // Reported 2026-09-17: the installed PWA showed a ~95px gray band under
  // the status bar. Root cause: extractThemeInfo let the aliases borrow
  // github-dark's #24292e / github-light's #ffffff wholesale, and the engine
  // derived every chrome token from it — replacing the fleet palette
  // globals.css ships (#1e1e2d / #101117, Sam 2026-09-02/03). The aliases
  // must seed bg/fg/comment from the fleet so the derived chrome keeps the
  // designed look; every value below is hardcoded so a regression to the
  // GitHub values fails by name, not by shade.
  const githubDark = {
    colors: {
      "editor.background": "#24292e",
      "editor.foreground": "#e6edf3",
    },
    settings: [{ settings: { foreground: "#8b949e" } }],
  };
  const dark = extractThemeInfo(BUZZ_DARK_THEME_NAME, githubDark);
  assert.equal(dark.bg, "#1e1e2d");
  assert.equal(dark.fg, "#cad3f5");
  assert.equal(dark.comment, "#b8c0e0");

  const githubLight = {
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1f2328",
    },
    settings: [{ settings: { foreground: "#59636e" } }],
  };
  const light = extractThemeInfo(BUZZ_THEME_NAME, githubLight);
  assert.equal(light.bg, "#eff1f5");
  assert.equal(light.fg, "#4c4f69");
  assert.equal(light.comment, "#5c5f77");
});

test("a non-alias theme keeps its own editor colors", () => {
  // The fleet seeding is an alias-only intervention; a bundled theme passing
  // through extractThemeInfo must keep the colors its bundle declares.
  const mocha = {
    colors: {
      "editor.background": "#24273a",
      "editor.foreground": "#cad3f5",
    },
    settings: [{ scope: "comment", settings: { foreground: "#6e738d" } }],
  };
  const info = extractThemeInfo("catppuccin-mocha", mocha);
  assert.equal(info.bg, "#24273a");
  assert.equal(info.fg, "#cad3f5");
  assert.equal(info.comment, "#6e738d");
});
