import { useMemo } from "react";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { isLightTheme } from "@/shared/theme/theme-loader";
import { cn } from "@/shared/lib/cn";

/**
 * Human labels for the theme registry.
 *
 * The registry stores Shiki bundle ids (`catppuccin-mocha`), which are fine as
 * keys and poor as UI. Rather than hand-maintain ~55 labels that will drift
 * the moment a theme is added, derive them and special-case only the names
 * where title-casing gets it wrong.
 */
const SPECIAL_LABELS: Record<string, string> = {
  buzz: "Buzz",
  "buzz-dark": "Buzz Dark",
  "github-light": "GitHub Light",
  "github-dark": "GitHub Dark",
  "github-light-default": "GitHub Light Default",
  "github-dark-default": "GitHub Dark Default",
  "github-light-high-contrast": "GitHub Light High Contrast",
  "github-dark-high-contrast": "GitHub Dark High Contrast",
  "github-dark-dimmed": "GitHub Dark Dimmed",
  "one-dark-pro": "One Dark Pro",
  "one-light": "One Light",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  "rose-pine-moon": "Rosé Pine Moon",
  "slack-dark": "Slack Dark",
  "slack-ochin": "Slack Ochin",
  "synthwave-84": "Synthwave '84",
  "tokyo-night": "Tokyo Night",
  "min-light": "Min Light",
  "min-dark": "Min Dark",
  "material-theme": "Material",
  "material-theme-darker": "Material Darker",
  "material-theme-lighter": "Material Lighter",
  "material-theme-ocean": "Material Ocean",
  "material-theme-palenight": "Material Palenight",
};

function themeLabel(name: string): string {
  const special = SPECIAL_LABELS[name];
  if (special) return special;
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Appearance settings.
 *
 * The whole interface palette is derived at runtime from the selected syntax
 * theme, so this picker is the only place the ported theme engine is reachable
 * from. Without it the engine ships and is never used.
 */
export function AppearanceSection() {
  const {
    themeName,
    setThemeName,
    followSystem,
    setFollowSystem,
    availableThemes,
    isDark,
  } = useTheme();

  // Group by polarity so "follow the system" has an obvious meaning: the
  // selection is the family, and the OS picks which half of it applies.
  const { light, dark } = useMemo(() => {
    const light: string[] = [];
    const dark: string[] = [];
    for (const name of availableThemes) {
      (isLightTheme(name) ? light : dark).push(name);
    }
    return { light, dark };
  }, [availableThemes]);

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">Appearance</h2>
        <span className="text-xs text-muted-foreground">
          {isDark ? "Dark" : "Light"} right now
        </span>
      </div>

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-[hsl(var(--primary))]"
          checked={followSystem}
          onChange={(event) => setFollowSystem(event.target.checked)}
        />
        <span>
          <span className="block">Match my system</span>
          <span className="block text-xs text-muted-foreground">
            Switches between the light and dark halves of your chosen theme as
            your device changes.
          </span>
        </span>
      </label>

      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor="appearance-theme">
          Theme
        </label>
        <select
          id="appearance-theme"
          className={cn(
            "h-9 w-full rounded-md border border-input bg-background px-2 text-sm",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          value={themeName}
          onChange={(event) => setThemeName(event.target.value)}
        >
          <optgroup label="Light">
            {light.map((name) => (
              <option key={name} value={name}>
                {themeLabel(name)}
              </option>
            ))}
          </optgroup>
          <optgroup label="Dark">
            {dark.map((name) => (
              <option key={name} value={name}>
                {themeLabel(name)}
              </option>
            ))}
          </optgroup>
        </select>
        <p className="text-xs text-muted-foreground">
          Every colour in the interface is derived from the theme you pick.
        </p>
      </div>
    </section>
  );
}
