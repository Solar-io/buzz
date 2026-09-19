import type { CSSProperties, ChangeEvent } from "react";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { blendHex, clampMidpoint } from "@/shared/theme/custom-gradient";

type ColorKey =
  | "gradientColor1"
  | "gradientColor2"
  | "lightContentColor"
  | "darkContentColor";

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
      {label}
      <input
        aria-label={label}
        className="h-11 w-14 cursor-pointer rounded border border-input bg-transparent p-1"
        type="color"
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

export function CustomGradientThemeEditor() {
  const { customGradient, setCustomGradient, isDark } = useTheme();
  const setColor = (key: ColorKey) => (event: ChangeEvent<HTMLInputElement>) =>
    setCustomGradient({ ...customGradient, [key]: event.target.value });
  const content = isDark
    ? customGradient.darkContentColor
    : customGradient.lightContentColor;
  const previewStyle = {
    "--preview-color-1": customGradient.gradientColor1,
    "--preview-color-2": customGradient.gradientColor2,
    "--preview-mix": blendHex(
      customGradient.gradientColor1,
      customGradient.gradientColor2,
    ),
    "--preview-midpoint": `${customGradient.midpoint}%`,
    "--preview-content": content,
    "--preview-nav-wash": isDark ? "0 0% 0%" : "0 0% 100%",
  } as CSSProperties;

  return (
    <fieldset className="space-y-4 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Custom Gradient</legend>
      <section aria-labelledby="shell-gradient-heading" className="space-y-2">
        <div>
          <h3 id="shell-gradient-heading" className="text-sm font-medium">
            Shell gradient
          </h3>
          <p className="text-xs text-muted-foreground">
            This gradient stays the same in Light, Dark, and System mode.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <ColorControl
            label="Gradient color 1"
            value={customGradient.gradientColor1}
            onChange={setColor("gradientColor1")}
          />
          <ColorControl
            label="Gradient color 2"
            value={customGradient.gradientColor2}
            onChange={setColor("gradientColor2")}
          />
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
      </section>
      <section aria-labelledby="content-surfaces-heading" className="space-y-2">
        <div>
          <h3 id="content-surfaces-heading" className="text-sm font-medium">
            Content surfaces
          </h3>
          <p className="text-xs text-muted-foreground">
            Chat, Replies, and Thinking use these colors in Light, Dark, or
            System mode.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <ColorControl
            label="Light content color"
            value={customGradient.lightContentColor}
            onChange={setColor("lightContentColor")}
          />
          <ColorControl
            label="Dark content color"
            value={customGradient.darkContentColor}
            onChange={setColor("darkContentColor")}
          />
        </div>
      </section>
      <div
        aria-label="Custom gradient live preview"
        className="custom-gradient-preview grid h-28 grid-cols-[26%_1fr_20%_20%] gap-1 overflow-hidden rounded-md border border-border p-1"
        role="img"
        style={previewStyle}
      >
        <div className="custom-gradient-preview-nav -m-1 mr-0 border-r border-black/10 p-2">
          <div className="h-2 w-3/4 rounded bg-black/30" />
        </div>
        {["Chat", "Replies", "Thinking"].map((label) => (
          <div
            key={label}
            className="rounded-lg border border-black/10 bg-[var(--preview-content)] p-2 text-[10px] text-black/70 shadow-sm"
          >
            {label}
          </div>
        ))}
      </div>
    </fieldset>
  );
}
