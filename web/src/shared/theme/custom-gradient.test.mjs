import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUSTOM_GRADIENT_DARK,
  CUSTOM_GRADIENT_LIGHT,
  DEFAULT_CUSTOM_GRADIENT,
  blendHex,
  clampMidpoint,
  contrastRatio,
  customGradientThemeForDark,
  customGradientVars,
  loadCustomGradientConfig,
} from "./custom-gradient.ts";

const V1 = JSON.stringify({
  version: 1,
  lightColor: "#aabbcc",
  darkColor: "#112233",
  midpoint: 37,
});
const V2 = JSON.stringify({
  version: 2,
  gradientColor1: "#010203",
  gradientColor2: "#a0b0c0",
  midpoint: 64,
  lightContentColor: "#fefefe",
  darkContentColor: "#121212",
});

test("valid v1 migrates exactly into the four-color v2 schema", () => {
  assert.deepEqual(loadCustomGradientConfig(null, V1), {
    migratedFromV1: true,
    config: {
      version: 2,
      gradientColor1: "#aabbcc",
      gradientColor2: "#112233",
      midpoint: 37,
      lightContentColor: "#aabbcc",
      darkContentColor: "#112233",
    },
  });
});

test("valid v2 wins over valid v1", () => {
  const loaded = loadCustomGradientConfig(V2, V1);
  assert.equal(loaded.migratedFromV1, false);
  assert.deepEqual(loaded.config, JSON.parse(V2));
});

test("corrupt v2 falls back to v1, then exact defaults", () => {
  assert.equal(loadCustomGradientConfig("not-json", V1).migratedFromV1, true);
  assert.deepEqual(
    loadCustomGradientConfig("not-json", "also-bad").config,
    DEFAULT_CUSTOM_GRADIENT,
  );
});

test("midpoint clamps and blend has known endpoints", () => {
  assert.equal(clampMidpoint(-4), 0);
  assert.equal(clampMidpoint(104), 100);
  assert.equal(blendHex("#000000", "#ffffff", 0.5), "#808080");
});

test("mode changes content only and leaves every gradient variable byte-identical", () => {
  const config = loadCustomGradientConfig(V2, null).config;
  const light = customGradientVars(config, false);
  const dark = customGradientVars(config, true);
  for (const name of [
    "--custom-gradient-color-1",
    "--custom-gradient-color-2",
    "--custom-gradient-midpoint",
    "--custom-gradient-mix",
  ]) {
    assert.equal(light[name], dark[name], `${name} must ignore mode`);
  }
  assert.equal(light["--custom-gradient-content"], "#fefefe");
  assert.equal(dark["--custom-gradient-content"], "#121212");
});

test("content tonal tokens remain subtle and readable", () => {
  const vars = customGradientVars(
    loadCustomGradientConfig(V2, null).config,
    true,
  );
  assert.notEqual(
    vars["--custom-gradient-border-hsl"],
    vars["--custom-gradient-content-foreground-hsl"],
  );
  assert.ok(
    contrastRatio(
      vars["--custom-gradient-content"],
      vars["--custom-gradient-muted-foreground"],
    ) >= 4.5,
  );
});

test("theme pair selector maps both polarities explicitly", () => {
  assert.equal(customGradientThemeForDark(false), CUSTOM_GRADIENT_LIGHT);
  assert.equal(customGradientThemeForDark(true), CUSTOM_GRADIENT_DARK);
});
