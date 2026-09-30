import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DERIVED_VAR_NAMES, hexToHsl } from "./adaptive-theme.ts";
import {
  FIXED_THEME_FOR,
  PALETTE_META_BG,
  resolveThemeApplication,
} from "./fixed-palettes.ts";

const PALETTES_CSS = new URL("../styles/palettes.css", import.meta.url);

/** An HSL triple as numbers — the formatter writes `45` where hexToHsl says `45.0`. */
function numeric(triple) {
  return triple
    .split(/\s+/)
    .map((part) => Number.parseFloat(part))
    .join(" ");
}

/** Parse palettes.css into { paletteId: { --name: value } }. */
function paletteBlocks() {
  const css = readFileSync(PALETTES_CSS, "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const blocks = {};
  for (const match of css.matchAll(
    /:root\[data-palette="([^"]+)"\]\s*\{([^}]*)\}/g,
  )) {
    const vars = {};
    for (const decl of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars[decl[1]] = decl[2].trim();
    }
    blocks[match[1]] = vars;
  }
  return blocks;
}

test("resolveThemeApplication: mapped names are fixed, everything else derived", () => {
  assert.deepEqual(
    FIXED_THEME_FOR,
    {},
    "Phase 0 maps no theme — nothing may change on screen",
  );
  const map = { buzz: "buzz-light" };
  assert.deepEqual(resolveThemeApplication("buzz", map), {
    kind: "fixed",
    palette: "buzz-light",
    isDark: false,
  });
  // Unmapped names — including the buzz sibling — take the engine.
  const dark = resolveThemeApplication("buzz-dark", map);
  assert.equal(dark.kind, "derived");
  assert.equal(
    resolveThemeApplication("catppuccin-mocha", map).kind,
    "derived",
  );
  // With the real (empty) map, even `buzz` is derived.
  assert.equal(resolveThemeApplication("buzz").kind, "derived");
  // A prototype key is not a mapping.
  assert.equal(resolveThemeApplication("constructor", map).kind, "derived");
});

test("palettes.css defines every derived var in both palettes", () => {
  assert.ok(
    DERIVED_VAR_NAMES.length > 20,
    `DERIVED_VAR_NAMES has ${DERIVED_VAR_NAMES.length} names`,
  );
  const blocks = paletteBlocks();
  assert.deepEqual(
    Object.keys(blocks).sort(),
    ["buzz-dark", "buzz-light"],
    "palettes.css parses to exactly the two palette blocks",
  );
  const required = [
    ...DERIVED_VAR_NAMES,
    // The accent set the engine does not emit, plus --radius.
    "--primary",
    "--primary-foreground",
    "--sidebar-primary",
    "--sidebar-primary-foreground",
    "--sidebar-active",
    "--sidebar-active-foreground",
    "--radius",
  ];
  for (const [id, vars] of Object.entries(blocks)) {
    const missing = required.filter((name) => !(name in vars));
    assert.deepEqual(missing, [], `${id} is missing ${missing.join(", ")}`);
  }
});

test("PALETTE_META_BG equals each palette's --background", () => {
  const blocks = paletteBlocks();
  const ids = Object.keys(PALETTE_META_BG);
  assert.equal(ids.length, 2);
  for (const id of ids) {
    assert.equal(
      numeric(blocks[id]?.["--background"] ?? ""),
      numeric(hexToHsl(PALETTE_META_BG[id])),
      `${id}: theme-color meta and --background disagree`,
    );
  }
});
