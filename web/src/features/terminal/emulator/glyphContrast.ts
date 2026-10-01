/**
 * Rescue box-drawing glyphs painted in (nearly) the background colour.
 * Ported from evie-ui `term-glyph-contrast.js`.
 *
 * herdr paints the rules inside its own sidebar with a token that equals the
 * terminal background (contrast ~1.0, invisible). The vendored GPU renderers
 * carry a patch that asks `globalThis.__evieBoxGlyphFg(css)` for every box
 * glyph's FOREGROUND, so the lift touches rules and never a selection
 * background. xterm's own `minimumContrastRatio` skips the custom-glyph path.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseCssColor(css: unknown): Rgb | null {
  if (typeof css !== "string") return null;
  const s = css.trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) {
      const [r, g, b] = [0, 1, 2].map((i) =>
        parseInt(h.charAt(i).repeat(2), 16),
      );
      return Number.isNaN((r ?? NaN) + (g ?? NaN) + (b ?? NaN))
        ? null
        : { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return Number.isNaN(r + g + b) ? null : { r, g, b };
    }
    return null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (!m?.[1]) return null;
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((p) => parseFloat(p));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) {
    return null;
  }
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 };
}

export function relativeLuminance(c: Rgb): number {
  const chan = (v: number) => {
    const x = Math.min(255, Math.max(0, v)) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(c: Rgb, target: Rgb, t: number): Rgb {
  return {
    r: Math.round(c.r + (target.r - c.r) * t),
    g: Math.round(c.g + (target.g - c.g) * t),
    b: Math.round(c.b + (target.b - c.b) * t),
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** The smallest move toward white (dark bg) or black (light bg) that reaches `minRatio`. */
export function liftToContrast(fg: Rgb, bg: Rgb, minRatio: number): Rgb {
  if (contrastRatio(fg, bg) >= minRatio) return fg;
  const target = relativeLuminance(bg) < 0.5 ? WHITE : BLACK;
  if (contrastRatio(target, bg) < minRatio) return target;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(fg, target, mid), bg) >= minRatio) hi = mid;
    else lo = mid;
  }
  return mix(fg, target, hi);
}

export function rgbToCss(c: Rgb): string {
  const h = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** The filter the patched renderers call. Identity when the background is unparseable. */
export function makeBoxGlyphFg(options: {
  background: string;
  minContrast: number;
}): (css: string) => string {
  const bg = parseCssColor(options.background);
  if (!bg || !(options.minContrast > 1)) return (css) => css;
  const cache = new Map<string, string>();
  return (css) => {
    if (typeof css !== "string") return css;
    const hit = cache.get(css);
    if (hit !== undefined) return hit;
    const fg = parseCssColor(css);
    const out = fg
      ? rgbToCss(liftToContrast(fg, bg, options.minContrast))
      : css;
    cache.set(css, out);
    return out;
  };
}
