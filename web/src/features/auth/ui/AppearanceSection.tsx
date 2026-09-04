import { useMemo } from "react";
import { useTheme, type ThemeMode } from "@/shared/theme/ThemeProvider";
import { isLightTheme } from "@/shared/theme/theme-loader";
import { cn } from "@/shared/lib/cn";
import { AccentPicker } from "@/features/settings/ui/AccentPicker";
import { AppearancePreferences } from "@/features/settings/ui/AppearancePreferences";
import { SegmentedControl } from "@/features/settings/ui/SegmentedControl";

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

const COLOR_MODE_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const satisfies readonly { value: ThemeMode; label: string }[];

/**
 * Appearance settings.
 *
 * The whole interface palette is derived at runtime from the selected syntax
 * theme, so this picker is the only place the ported theme engine is reachable
 * from. Without it the engine ships and is never used.
 *
 * The same was true of two other things the provider already exposed and
 * nothing rendered: `mode`/`setMode` (the Light / Dark / System control below,
 * which replaced a "Match my system" checkbox — same state, but it also lets
 * you pin the light or dark half of a paired family without hunting for its
 * partner in the list) and `accent`/`setAccent` (the swatches). Code that
 * works but is unreachable looks exactly like code that works, which is why
 * `settings.spec.ts` renders this card rather than trusting a unit test.
 *
 * Below the theme controls sit the reading-comfort preferences —
 * `AppearancePreferences` — kept in their own file so this one stays a
 * composition root under the 1000-line ceiling.
 *
 * Not ported from the desktop, and why:
 *   Glass background / Glass opacity — a native macOS window effect (Tauri's
 *   `NSVisualEffectView`); a web page cannot blur what is behind the browser.
 *   Prominent active tab — styles the navigation rail, which lives in
 *   `features/sidebar/`; the preference is meaningful in a browser but the
 *   control would be dead until the sidebar reads it.
 */
export function AppearanceSection() {
  const {
    themeName,
    setThemeName,
    availableThemes,
    isDark,
    mode,
    setMode,
    accent,
    setAccent,
  } = useTheme();

  // Group by polarity so "System" has an obvious meaning: the selection is the
  // family, and the OS picks which half of it applies.
  const { light, dark } = useMemo(() => {
    const light: string[] = [];
    const dark: string[] = [];
    for (const name of availableThemes) {
      (isLightTheme(name) ? light : dark).push(name);
    }
    return { light, dark };
  }, [availableThemes]);

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="appearance-card"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">Appearance</h2>
        <span className="text-xs text-muted-foreground">
          {isDark ? "Dark" : "Light"} right now
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Colour mode</p>
          <p className="text-xs text-muted-foreground">
            System follows your device, swapping between the light and dark
            halves of your chosen theme.
          </p>
        </div>
        <SegmentedControl
          legend="Colour mode"
          onValueChange={setMode}
          optionTestIdPrefix="color-mode"
          options={COLOR_MODE_OPTIONS}
          testId="color-mode-control"
          value={mode}
        />
      </div>

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

      <AccentPicker accent={accent} setAccent={setAccent} />

      <AppearancePreferences />
    </section>
  );
}
