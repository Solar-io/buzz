import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUSTOM_GRADIENT_DARK,
  CUSTOM_GRADIENT_LIGHT,
  DEFAULT_CUSTOM_GRADIENT,
  blendHex,
  clampMidpoint,
  contrastColor,
  customGradientThemeForDark,
  customGradientVars,
  normalizeHex,
  parseCustomGradientConfig,
  contrastRatio,
} from "./custom-gradient.ts";

test("corrupt and unsupported stored configurations fall back safely", () => {
  assert.deepEqual(
    parseCustomGradientConfig("not-json"),
    DEFAULT_CUSTOM_GRADIENT,
  );
  assert.deepEqual(
    parseCustomGradientConfig('{"version":2,"lightColor":"#ffffff"}'),
    DEFAULT_CUSTOM_GRADIENT,
  );
});

test("stored colors are canonicalized and invalid fields fall back independently", () => {
  assert.deepEqual(
    parseCustomGradientConfig(
      '{"version":1,"lightColor":" #ABC ","darkColor":"oops","midpoint":120}',
    ),
    {
      version: 1,
      lightColor: "#aabbcc",
      darkColor: DEFAULT_CUSTOM_GRADIENT.darkColor,
      midpoint: 100,
    },
  );
  assert.equal(normalizeHex("#A0b1C2"), "#a0b1c2");
});

test("midpoint clamps to the inclusive range and blend has known endpoints", () => {
  assert.equal(clampMidpoint(-4), 0);
  assert.equal(clampMidpoint(104), 100);
  assert.equal(clampMidpoint("37.6"), 38);
  assert.equal(blendHex("#000000", "#ffffff", 0), "#000000");
  assert.equal(blendHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(blendHex("#000000", "#ffffff", 1), "#ffffff");
});

test("contrast and pane endpoint change with resolved polarity", () => {
  assert.equal(contrastColor("#ffffff"), "#000000");
  assert.equal(contrastColor("#000000"), "#ffffff");
  const config = {
    version: 1,
    lightColor: "#abcdef",
    darkColor: "#123456",
    midpoint: 35,
  };
  assert.equal(
    customGradientVars(config, false)["--custom-gradient-pane"],
    "#abcdef",
  );
  assert.equal(
    customGradientVars(config, true)["--custom-gradient-pane"],
    "#123456",
  );
  assert.equal(
    customGradientVars(config, false)["--custom-gradient-pane-foreground"],
    "#000000",
  );
  assert.equal(
    customGradientVars(config, true)["--custom-gradient-pane-foreground"],
    "#ffffff",
  );
});

test("theme pair selector maps both polarities explicitly", () => {
  assert.equal(customGradientThemeForDark(false), CUSTOM_GRADIENT_LIGHT);
  assert.equal(customGradientThemeForDark(true), CUSTOM_GRADIENT_DARK);
});

test("pane tonal tokens remain distinct, subtle, and readable", () => {
  const vars = customGradientVars(
    { version: 1, lightColor: "#f1e2d3", darkColor: "#17132f", midpoint: 50 },
    true,
  );
  assert.equal(
    vars["--custom-gradient-card-hsl"],
    vars["--custom-gradient-pane-hsl"],
  );
  assert.notEqual(
    vars["--custom-gradient-secondary-hsl"],
    vars["--custom-gradient-pane-hsl"],
  );
  assert.notEqual(
    vars["--custom-gradient-border-hsl"],
    vars["--custom-gradient-pane-foreground-hsl"],
  );
  assert.ok(
    contrastRatio(
      vars["--custom-gradient-pane"],
      vars["--custom-gradient-muted-foreground"],
    ) >= 4.5,
  );
});
