export const CUSTOM_GRADIENT_LIGHT = "custom-gradient-light";
export const CUSTOM_GRADIENT_DARK = "custom-gradient-dark";
export const CUSTOM_GRADIENT_STORAGE_KEY = "buzz-custom-gradient-v1";

export const DEFAULT_CUSTOM_GRADIENT = {
  version: 1,
  lightColor: "#e7f0ff",
  darkColor: "#17132f",
  midpoint: 50,
} as const;

export interface CustomGradientConfig {
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

export function parseCustomGradientConfig(
  raw: string | null,
): CustomGradientConfig {
  if (!raw) return { ...DEFAULT_CUSTOM_GRADIENT };
  try {
    const value = JSON.parse(raw) as Partial<CustomGradientConfig>;
    if (value.version !== 1) return { ...DEFAULT_CUSTOM_GRADIENT };
    return {
      version: 1,
      lightColor:
        normalizeHex(value.lightColor) ?? DEFAULT_CUSTOM_GRADIENT.lightColor,
      darkColor:
        normalizeHex(value.darkColor) ?? DEFAULT_CUSTOM_GRADIENT.darkColor,
      midpoint: clampMidpoint(value.midpoint),
    };
  } catch {
    return { ...DEFAULT_CUSTOM_GRADIENT };
  }
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

function hslComponents(hex: string): string {
  const [red, green, blue] = rgb(hex).map((channel) => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return `0 0% ${(lightness * 100).toFixed(1)}%`;
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return `${((hue * 60 + 360) % 360).toFixed(1)} ${(saturation * 100).toFixed(1)}% ${(lightness * 100).toFixed(1)}%`;
}

export function blendHex(start: string, end: string, amount = 0.5): string {
  const a = rgb(normalizeHex(start) ?? DEFAULT_CUSTOM_GRADIENT.lightColor);
  const b = rgb(normalizeHex(end) ?? DEFAULT_CUSTOM_GRADIENT.darkColor);
  const weight = Math.min(1, Math.max(0, amount));
  return `#${a
    .map((channel, index) =>
      Math.round(channel + (b[index] - channel) * weight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function contrastColor(hex: string): "#000000" | "#ffffff" {
  const channels = rgb(normalizeHex(hex) ?? "#000000").map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

export function customGradientVars(
  config: CustomGradientConfig,
  dark: boolean,
): Record<string, string> {
  const pane = dark ? config.darkColor : config.lightColor;
  const foreground = contrastColor(pane);
  return {
    "--custom-gradient-light": config.lightColor,
    "--custom-gradient-dark": config.darkColor,
    "--custom-gradient-midpoint": `${config.midpoint}%`,
    "--custom-gradient-mix": blendHex(config.lightColor, config.darkColor),
    "--custom-gradient-pane": pane,
    "--custom-gradient-pane-hsl": hslComponents(pane),
    "--custom-gradient-pane-foreground": foreground,
    "--custom-gradient-pane-foreground-hsl": hslComponents(foreground),
  };
}

export const CUSTOM_GRADIENT_VAR_NAMES = Object.keys(
  customGradientVars({ ...DEFAULT_CUSTOM_GRADIENT }, false),
);
