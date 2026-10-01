/**
 * The terminal's palette from Buzz's tokens (phase-7.md §8 `emulator/theme.ts`;
 * a rewrite of evie-ui `core/term-theme.js`, which picked from 64 bearded
 * themes — Buzz has one terminal look per polarity, per the artboards).
 *
 * xterm does not read CSS: its GPU renderer colours every cell from
 * `options.theme`. So the page's `--term*` tokens are read here and handed
 * over again on every light/dark switch (boot.ts watches <html>).
 *
 * The ANSI 16: the slots the artboard names come from tokens (red = coral
 * ink, green = the diff-add ink, yellow = --term-warn, blue = --term-hl,
 * bright black = --term-dim). The rest are fixed per polarity below, chosen
 * to sit beside those inks and clear contrast on --term (normals ≥ 4.5:1,
 * brights ≥ 3:1).
 */

export interface TermTokens {
  background: string;
  foreground: string;
  dim: string;
  green: string;
  blue: string;
  yellow: string;
  red: string;
}

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The slots no token names, per polarity. */
const FIXED = {
  light: {
    magenta: "#7d3f82",
    cyan: "#1d6a6f",
    white: "#5e5a52",
    brightRed: "#c8452b",
    brightGreen: "#2e8a5e",
    brightYellow: "#9a6a00",
    brightBlue: "#2f63a8",
    brightMagenta: "#97509c",
    brightCyan: "#257f85",
    brightWhite: "#1b1a16",
    selection: "rgba(31, 78, 140, 0.18)",
  },
  dark: {
    magenta: "#d2a8da",
    cyan: "#8ccaca",
    white: "#bdbab4",
    brightRed: "#f2b3a5",
    brightGreen: "#a9dcbd",
    brightYellow: "#e9cb8c",
    brightBlue: "#c2d4ec",
    brightMagenta: "#e3c3e8",
    brightCyan: "#a9dddd",
    brightWhite: "#f2f0ec",
    selection: "rgba(165, 190, 223, 0.25)",
  },
} as const;

/** Pure: tokens + polarity → the xterm theme object. */
export function buildTermTheme(tokens: TermTokens, dark: boolean): XtermTheme {
  const fixed = dark ? FIXED.dark : FIXED.light;
  return {
    background: tokens.background,
    foreground: tokens.foreground,
    cursor: tokens.foreground,
    cursorAccent: tokens.background,
    selectionBackground: fixed.selection,
    black: dark ? "#2a2a2a" : tokens.foreground,
    red: tokens.red,
    green: tokens.green,
    yellow: tokens.yellow,
    blue: tokens.blue,
    magenta: fixed.magenta,
    cyan: fixed.cyan,
    white: fixed.white,
    brightBlack: tokens.dim,
    brightRed: fixed.brightRed,
    brightGreen: fixed.brightGreen,
    brightYellow: fixed.brightYellow,
    brightBlue: fixed.brightBlue,
    brightMagenta: fixed.brightMagenta,
    brightCyan: fixed.brightCyan,
    brightWhite: fixed.brightWhite,
  };
}

/** Light-mode fallbacks, so a missing stylesheet still yields a readable terminal. */
const FALLBACK: TermTokens = {
  background: "#fbfaf7",
  foreground: "#1f1e1b",
  dim: "#7a756b",
  green: "#1c6644",
  blue: "#1f4e8c",
  yellow: "#9a5b00",
  red: "#a2301a",
};

/** `--coral-ink` is an HSL triple ("9.7 72.34% 36.9%"); turn it into hex. */
export function hslTripleToHex(triple: string): string | null {
  const m = triple.trim().match(/^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return null;
  const h = (((Number(m[1]) % 360) + 360) % 360) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const hue = (p: number, q: number, t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let r = l;
  let g = l;
  let b = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const hex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Read the live tokens off <html>. */
export function readTermTokens(
  root: Element = document.documentElement,
): TermTokens {
  const cs = getComputedStyle(root);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--term", FALLBACK.background),
    foreground: v("--term-ink", FALLBACK.foreground),
    dim: v("--term-dim", FALLBACK.dim),
    green: v("--term-add-ink", FALLBACK.green),
    blue: v("--term-hl", FALLBACK.blue),
    yellow: v("--term-warn", FALLBACK.yellow),
    red: hslTripleToHex(v("--coral-ink", "")) ?? FALLBACK.red,
  };
}

export function isDarkMode(root: Element = document.documentElement): boolean {
  return root.classList.contains("dark");
}
