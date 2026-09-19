import type { CSSProperties, ChangeEvent } from "react";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { blendHex, clampMidpoint } from "@/shared/theme/custom-gradient";

export function CustomGradientThemeEditor() {
  const { customGradient, setCustomGradient, isDark } = useTheme();

  const setColor =
    (key: "lightColor" | "darkColor") =>
    (event: ChangeEvent<HTMLInputElement>) =>
      setCustomGradient({ ...customGradient, [key]: event.target.value });

  const previewStyle = {
    "--preview-light": customGradient.lightColor,
    "--preview-dark": customGradient.darkColor,
    "--preview-mix": blendHex(
      customGradient.lightColor,
      customGradient.darkColor,
    ),
    "--preview-midpoint": `${customGradient.midpoint}%`,
    "--preview-pane": isDark
      ? customGradient.darkColor
      : customGradient.lightColor,
    "--preview-nav-wash": isDark ? "0 0% 0%" : "0 0% 100%",
  } as CSSProperties;

  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Custom Gradient</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
          Light color
          <input
            aria-label="Custom gradient light color"
            className="h-11 w-14 cursor-pointer rounded border border-input bg-transparent p-1"
            type="color"
            value={customGradient.lightColor}
            onChange={setColor("lightColor")}
          />
        </label>
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
          Dark color
          <input
            aria-label="Custom gradient dark color"
            className="h-11 w-14 cursor-pointer rounded border border-input bg-transparent p-1"
            type="color"
            value={customGradient.darkColor}
            onChange={setColor("darkColor")}
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm" htmlFor="gradient-midpoint">
        <span className="flex justify-between gap-3">
          <span>Transition midpoint</span>
          <output htmlFor="gradient-midpoint">
            {customGradient.midpoint}%
          </output>
        </span>
        <input
          id="gradient-midpoint"
          aria-valuetext={`${customGradient.midpoint} percent`}
          className="h-11 w-full cursor-pointer accent-primary"
          min="0"
          max="100"
          type="range"
          value={customGradient.midpoint}
          onChange={(event) =>
            setCustomGradient({
              ...customGradient,
              midpoint: clampMidpoint(event.target.value),
            })
          }
        />
      </label>
      <div
        aria-label="Custom gradient live preview"
        className="custom-gradient-preview grid h-24 grid-cols-[28%_1fr_24%] overflow-hidden rounded-md border border-border"
        role="img"
        style={previewStyle}
      >
        <div className="custom-gradient-preview-nav border-r border-black/10 p-2">
          <div className="h-2 w-3/4 rounded bg-black/30" />
        </div>
        <div className="m-2 rounded-xl border border-black/10 bg-[var(--preview-pane)] shadow-sm" />
        <div className="m-2 ml-0 rounded-xl border border-black/10 bg-[var(--preview-pane)] shadow-sm" />
      </div>
      <p className="text-xs text-muted-foreground">
        Navigation floats over one continuous gradient. Chat and Thinking use
        the selected light or dark color as inset solid surfaces.
      </p>
    </fieldset>
  );
}
