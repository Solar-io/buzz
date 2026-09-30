import { type SyntaxThemeName, resolveShikiThemeName } from "./theme-loader.ts";

/**
 * Fixed palettes (web redesign Phase 0; phase-0.md §2).
 *
 * Every other theme is DERIVED: the adaptive engine turns a syntax theme's
 * four key colours into the interface palette and writes it inline on
 * `<html>`. A fixed palette is instead a hand-specified stylesheet block
 * (`shared/styles/palettes.css`) selected by `data-palette` on `<html>`;
 * ThemeProvider clears the engine's inline vars and sets the attribute.
 *
 * Phase 0 ships the mechanism with NO theme mapped, so nothing changes on
 * screen. Phase 1 maps `buzz` → buzz-light and `buzz-dark` → buzz-dark.
 * Syntax highlighting is unaffected either way: code blocks resolve their
 * Shiki theme from the theme NAME, not from the palette.
 */
export type PaletteId = "buzz-light" | "buzz-dark";

export const PALETTE_IS_DARK: Readonly<Record<PaletteId, boolean>> = {
  "buzz-light": false,
  "buzz-dark": true,
};

/**
 * `theme-color` meta content per palette — the one value duplicated between
 * TS and CSS (each palette's `--background`; pinned by
 * fixed-palettes.test.mjs). The meta must be set before first paint, when
 * the stylesheet value is not yet readable.
 */
export const PALETTE_META_BG: Readonly<Record<PaletteId, string>> = {
  "buzz-light": "#FDFCF9",
  "buzz-dark": "#141414",
};

/** Which theme names paint with a fixed palette. Empty in Phase 0. */
export const FIXED_THEME_FOR: Readonly<
  Partial<Record<SyntaxThemeName, PaletteId>>
> = Object.freeze({});

export type ThemeApplication =
  | { kind: "fixed"; palette: PaletteId; isDark: boolean }
  | { kind: "derived"; shikiName: SyntaxThemeName };

/** Decide how the theme `name` is applied: a fixed palette or the engine. */
export function resolveThemeApplication(
  name: string,
  map: Readonly<Partial<Record<string, PaletteId>>> = FIXED_THEME_FOR,
): ThemeApplication {
  // Own keys only: "constructor" and friends are not mappings.
  const palette: PaletteId | undefined = Object.getOwnPropertyDescriptor(
    map,
    name,
  )?.value;
  if (palette) {
    return { kind: "fixed", palette, isDark: PALETTE_IS_DARK[palette] };
  }
  return { kind: "derived", shikiName: resolveShikiThemeName(name) };
}
