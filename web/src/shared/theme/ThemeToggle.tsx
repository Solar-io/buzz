import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemeMode, useTheme } from "@/shared/theme/ThemeProvider";
import { Button } from "@/shared/ui/button";

const icons = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

const next: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

/**
 * Coarse light / dark / system cycle.
 *
 * This only moves polarity — it keeps whichever theme family the user has
 * chosen by switching to its pair, so a Catppuccin Latte user lands on Mocha
 * rather than a default. Picking a specific theme is the settings picker's
 * job; this is the one-click control.
 */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const Icon = icons[mode];

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => setMode(next[mode])}
      aria-label={`Theme: ${mode}. Click to switch.`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
