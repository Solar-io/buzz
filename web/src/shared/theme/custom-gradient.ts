export const CUSTOM_GRADIENT_LIGHT = "custom-gradient-light";
export const CUSTOM_GRADIENT_DARK = "custom-gradient-dark";
export const CUSTOM_GRADIENT_V1_STORAGE_KEY = "buzz-custom-gradient-v1";
export const CUSTOM_GRADIENT_STORAGE_KEY = "buzz-custom-gradient-v2";

export const DEFAULT_CUSTOM_GRADIENT = {
  version: 2,
  gradientColor1: "#4c9ed0",
  gradientColor2: "#0e2a6e",
  midpoint: 50,
  lightContentColor: "#ffffff",
  darkContentColor: "#17132f",
} as const;

export interface CustomGradientConfig {
  version: 2;
  gradientColor1: string;
  gradientColor2: string;
  midpoint: number;
  lightContentColor: string;
  darkContentColor: string;
}

interface V1Config {
  version: 1;
  lightColor: string;
  darkColor: string;
  midpoint: number;
}

export function isCustomGradientTheme(name: string): boolean {
  return name === CUSTOM_GRADIENT_LIGHT || name === CUSTOM_GRADIENT_DARK;
}
export function customGradientThemeForDark(dark: boolean): string {
  return dark ? CUSTOM_GRADIENT_DARK : CUSTOM_GRADIENT_LIGHT;
}
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  return short
    ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
    : null;
}
export function clampMidpoint(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number)
    ? Math.min(100, Math.max(0, Math.round(number)))
    : 50;
}

function objectFrom(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseV2(raw: string | null): CustomGradientConfig | null {
  const value = objectFrom(raw);
  if (value?.version !== 2) return null;
  const gradientColor1 = normalizeHex(value.gradientColor1);
  const gradientColor2 = normalizeHex(value.gradientColor2);
  const lightContentColor = normalizeHex(value.lightContentColor);
  const darkContentColor = normalizeHex(value.darkContentColor);
  if (
    !gradientColor1 ||
    !gradientColor2 ||
    !lightContentColor ||
    !darkContentColor
  )
    return null;
  return {
    version: 2,
    gradientColor1,
    gradientColor2,
    midpoint: clampMidpoint(value.midpoint),
    lightContentColor,
    darkContentColor,
  };
}

function parseV1(raw: string | null): V1Config | null {
  const value = objectFrom(raw);
  if (value?.version !== 1) return null;
  const lightColor = normalizeHex(value.lightColor);
  const darkColor = normalizeHex(value.darkColor);
  return lightColor && darkColor
    ? {
        version: 1,
        lightColor,
        darkColor,
        midpoint: clampMidpoint(value.midpoint),
      }
    : null;
}

export function loadCustomGradientConfig(
  v2Raw: string | null,
  v1Raw: string | null,
): { config: CustomGradientConfig; migratedFromV1: boolean } {
  const v2 = parseV2(v2Raw);
  if (v2) return { config: v2, migratedFromV1: false };
  const v1 = parseV1(v1Raw);
  if (v1) {
    return {
      config: {
        version: 2,
        gradientColor1: v1.lightColor,
        gradientColor2: v1.darkColor,
        midpoint: v1.midpoint,
        lightContentColor: v1.lightColor,
        darkContentColor: v1.darkColor,
      },
      migratedFromV1: true,
    };
  }
  return { config: { ...DEFAULT_CUSTOM_GRADIENT }, migratedFromV1: false };
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}
function hsl(hex: string): string {
  const [r, g, b] = rgb(hex).map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return `0 0% ${(lightness * 100).toFixed(1)}%`;
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return `${((hue * 60 + 360) % 360).toFixed(1)} ${(saturation * 100).toFixed(1)}% ${(lightness * 100).toFixed(1)}%`;
}
export function blendHex(start: string, end: string, amount = 0.5): string {
  const a = rgb(normalizeHex(start) ?? "#000000");
  const b = rgb(normalizeHex(end) ?? "#ffffff");
  const weight = Math.min(1, Math.max(0, amount));
  return `#${a
    .map((value, index) =>
      Math.round(value + (b[index] - value) * weight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
function luminance(hex: string): number {
  const values = rgb(normalizeHex(hex) ?? "#000000").map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
export function contrastRatio(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}
export function contrastColor(hex: string): "#000000" | "#ffffff" {
  return luminance(hex) > 0.179 ? "#000000" : "#ffffff";
}
function mutedForeground(content: string, foreground: string): string {
  for (let weight = 0.45; weight <= 1; weight += 0.01) {
    const candidate = blendHex(content, foreground, weight);
    if (contrastRatio(content, candidate) >= 4.5) return candidate;
  }
  return foreground;
}

export function customGradientVars(
  config: CustomGradientConfig,
  dark: boolean,
): Record<string, string> {
  const content = dark ? config.darkContentColor : config.lightContentColor;
  const foreground = contrastColor(content);
  const tonal = (amount: number) => hsl(blendHex(content, foreground, amount));
  const muted = mutedForeground(content, foreground);
  return {
    "--custom-gradient-color-1": config.gradientColor1,
    "--custom-gradient-color-2": config.gradientColor2,
    "--custom-gradient-midpoint": `${config.midpoint}%`,
    "--custom-gradient-mix": blendHex(
      config.gradientColor1,
      config.gradientColor2,
    ),
    "--custom-gradient-content": content,
    "--custom-gradient-content-hsl": hsl(content),
    "--custom-gradient-card-hsl": hsl(content),
    "--custom-gradient-popover-hsl": tonal(0.05),
    "--custom-gradient-secondary-hsl": tonal(0.06),
    "--custom-gradient-muted-hsl": tonal(0.08),
    "--custom-gradient-accent-hsl": tonal(0.1),
    "--custom-gradient-border-hsl": tonal(0.12),
    "--custom-gradient-input-hsl": tonal(0.12),
    "--custom-gradient-content-foreground": foreground,
    "--custom-gradient-content-foreground-hsl": hsl(foreground),
    "--custom-gradient-muted-foreground": muted,
    "--custom-gradient-muted-foreground-hsl": hsl(muted),
    "--custom-gradient-nav-wash-hsl": hsl(
      foreground === "#000000" ? "#ffffff" : "#000000",
    ),
    "--custom-gradient-nav-foreground-hsl": hsl(foreground),
  };
}

export const CUSTOM_GRADIENT_VAR_NAMES = [
  ...Object.keys(customGradientVars({ ...DEFAULT_CUSTOM_GRADIENT }, false)),
  "--custom-gradient-light",
  "--custom-gradient-dark",
  "--custom-gradient-pane",
  "--custom-gradient-pane-hsl",
  "--custom-gradient-pane-foreground",
  "--custom-gradient-pane-foreground-hsl",
];
