import assert from "node:assert/strict";
import { test } from "node:test";
import { createThemeVars, hexToHsl, luminance } from "./adaptive-theme.ts";

/**
 * Behaviour-pinning vectors for the adaptive theme engine.
 *
 * This file is the drift guard for `adaptive-theme.ts`, which is a copy of the
 * desktop's engine (see that file's header). It deliberately does NOT diff
 * against the desktop copy: the web owns its copy and is allowed to diverge.
 * What it pins is behaviour we can justify independently of the implementation,
 * so the test can actually fail if the math changes.
 *
 * Every expectation below is derivable from a spec or from a stated rule —
 * none of them were produced by running the code and recording the output.
 */

// --- luminance: WCAG relative luminance, independently known endpoints -------

test("luminance is 1 for white and 0 for black", () => {
  assert.equal(luminance("#ffffff"), 1);
  assert.equal(luminance("#000000"), 0);
});

test("luminance weights green above red above blue", () => {
  // WCAG coefficients are 0.2126 R / 0.7152 G / 0.0722 B, so pure primaries
  // must order green > red > blue regardless of the transfer function.
  const red = luminance("#ff0000");
  const green = luminance("#00ff00");
  const blue = luminance("#0000ff");
  assert.ok(green > red, `green ${green} should exceed red ${red}`);
  assert.ok(red > blue, `red ${red} should exceed blue ${blue}`);
});

// --- hexToHsl: HSL conversion, independently known values -------------------

test("hexToHsl converts pure primaries to their known HSL angles", () => {
  assert.equal(hexToHsl("#ff0000"), "0.0 100.00% 50.0%");
  assert.equal(hexToHsl("#00ff00"), "120.0 100.00% 50.0%");
  assert.equal(hexToHsl("#0000ff"), "240.0 100.00% 50.0%");
});

test("hexToHsl collapses achromatic colors to the zero-saturation form", () => {
  // max === min short-circuits to a hue and saturation of exactly 0.
  assert.equal(hexToHsl("#ffffff"), "0 0% 100.0%");
  assert.equal(hexToHsl("#000000"), "0 0% 0.0%");
  assert.equal(hexToHsl("#808080"), "0 0% 50.2%");
});

// --- createThemeVars: light/dark detection ----------------------------------

// Catppuccin base colours, the palette the web client is meant to ship.
const MOCHA_BG = "#1e1e2e";
const MOCHA_FG = "#cdd6f4";
const MOCHA_COMMENT = "#6c7086";
const LATTE_BG = "#eff1f5";
const LATTE_FG = "#4c4f69";
const LATTE_COMMENT = "#9ca0b0";

test("createThemeVars detects dark from background luminance", () => {
  // The documented rule is luminance(bg) < 0.5. Assert the rule holds AND
  // that the flag follows it, so the two cannot drift apart silently.
  assert.ok(luminance(MOCHA_BG) < 0.5);
  const { isDark } = createThemeVars(MOCHA_BG, MOCHA_FG, MOCHA_COMMENT);
  assert.equal(isDark, true);
});

test("createThemeVars detects light from background luminance", () => {
  assert.ok(luminance(LATTE_BG) >= 0.5);
  const { isDark } = createThemeVars(LATTE_BG, LATTE_FG, LATTE_COMMENT);
  assert.equal(isDark, false);
});

// --- createThemeVars: the variables the web client actually consumes --------

test("createThemeVars emits the core shadcn variables", () => {
  const { vars } = createThemeVars(MOCHA_BG, MOCHA_FG, MOCHA_COMMENT);
  // Hardcoded, not derived from Object.keys(vars) — a list read back off the
  // result would pass no matter what the engine emitted.
  for (const name of [
    "--background",
    "--foreground",
    "--card",
    "--popover",
    "--secondary",
    "--muted",
    "--accent",
    "--border",
    "--input",
    "--ring",
    "--sidebar-background",
    "--sidebar-foreground",
    "--sidebar-border",
  ]) {
    assert.ok(name in vars, `expected ${name} in the emitted vars`);
  }
});

test("the accent set is NOT the engine's responsibility", () => {
  // Load-bearing boundary, not a quirk. The engine derives neutral chrome
  // from the syntax theme; --primary and the sidebar active fill come from
  // the user's accent choice, applied separately by ThemeProvider. Anyone
  // porting the provider needs to know these are missing here, or the
  // selected-row fill silently resolves to nothing.
  const { vars } = createThemeVars(MOCHA_BG, MOCHA_FG, MOCHA_COMMENT);
  for (const name of [
    "--primary",
    "--primary-foreground",
    "--sidebar-primary",
    "--sidebar-active",
    "--sidebar-active-foreground",
  ]) {
    assert.ok(
      !(name in vars),
      `${name} is now emitted by the engine — ThemeProvider's accent layer must be updated to stop fighting it`,
    );
  }
});

test("emitted colors are HSL component triples, not hex", () => {
  // Tailwind wraps these in hsl(), so a hex value here paints nothing —
  // this is the exact class of bug that made web's pingFlash invisible.
  const { vars } = createThemeVars(MOCHA_BG, MOCHA_FG, MOCHA_COMMENT);
  const hslTriple = /^-?[\d.]+ [\d.]+% [\d.]+%$/;
  for (const name of ["--background", "--foreground", "--border"]) {
    assert.match(
      vars[name],
      hslTriple,
      `${name} = "${vars[name]}" is not an HSL component triple`,
    );
  }
});

test("git status colors fall back per theme polarity", () => {
  // Stated fallbacks in createThemeVars: dark #3fb950 / light #1a7f37 for
  // added, dark #f85149 / light #cf222e for deleted. The two differ, so this
  // assertion discriminates — a single shared fallback would fail it.
  const dark = createThemeVars(MOCHA_BG, MOCHA_FG, MOCHA_COMMENT).vars;
  const light = createThemeVars(LATTE_BG, LATTE_FG, LATTE_COMMENT).vars;

  assert.equal(dark["--status-added"], "#3fb950");
  assert.equal(light["--status-added"], "#1a7f37");
  assert.equal(dark["--status-deleted"], "#f85149");
  assert.equal(light["--status-deleted"], "#cf222e");
  assert.notEqual(dark["--status-added"], light["--status-added"]);
});

test("explicit git colors win over the fallbacks", () => {
  const { vars } = createThemeVars(MOCHA_BG, MOCHA_FG, MOCHA_COMMENT, {
    added: "#00ff00",
    deleted: "#ff0000",
    modified: null,
  });
  assert.equal(vars["--status-added"], "#00ff00");
  assert.equal(vars["--status-deleted"], "#ff0000");
});

test("a dark theme and a light theme do not produce the same background", () => {
  // Guards the whole derivation chain: if createThemeVars ever stopped
  // reading its bg argument, every other test here could still pass.
  const dark = createThemeVars(MOCHA_BG, MOCHA_FG, MOCHA_COMMENT).vars;
  const light = createThemeVars(LATTE_BG, LATTE_FG, LATTE_COMMENT).vars;
  assert.notEqual(dark["--background"], light["--background"]);
  assert.notEqual(dark["--foreground"], light["--foreground"]);
});
