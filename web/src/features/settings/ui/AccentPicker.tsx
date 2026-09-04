import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";

/**
 * Accent colour swatches.
 *
 * The ten colours are the desktop client's `ACCENT_COLORS`
 * (`shared/theme/ThemeProvider.tsx`), copied rather than imported — the web
 * client does not reach into the desktop package. The first entry differs on
 * purpose: the desktop calls it "Neutral" and substitutes its own black/white
 * pair, while here it means *no override at all*, so `globals.css` keeps its
 * deliberate values (including the selected-row purple the stylesheet
 * documents). That is why the store's accent is `string | null` rather than a
 * colour that is always set.
 *
 * The adaptive theme engine deliberately does not emit `--primary`,
 * `--sidebar-primary` or `--sidebar-active` — selection is a user preference,
 * not a property of a syntax theme — so this picker is the only thing that
 * writes them. `ThemeProvider.applyAccent` does the writing; this is the
 * surface that was missing, which is why `setAccent` shipped and was
 * unreachable.
 */
export const ACCENT_COLORS: readonly { name: string; value: string | null }[] =
  [
    { name: "Theme default", value: null },
    { name: "Blue", value: "#3b82f6" },
    { name: "Cyan", value: "#06b6d4" },
    { name: "Green", value: "#22c55e" },
    { name: "Orange", value: "#f97316" },
    { name: "Red", value: "#ef4444" },
    { name: "Pink", value: "#ec4899" },
    { name: "Lilac", value: "#c0a2f1" },
    { name: "Purple", value: "#a855f7" },
    { name: "Indigo", value: "#6366f1" },
  ];

export function AccentPicker({
  accent,
  setAccent,
}: {
  accent: string | null;
  setAccent: (hex: string | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Accent colour</p>
      <div
        className="flex flex-wrap gap-2 rounded-xl bg-muted p-2"
        data-testid="accent-color-options"
      >
        {ACCENT_COLORS.map((color) => {
          const selected = accent === color.value;
          return (
            <button
              aria-label={
                color.value === null
                  ? "Use the theme's own accent"
                  : `Use the ${color.name} accent`
              }
              aria-pressed={selected}
              className={cn(
                "relative flex size-8 shrink-0 items-center justify-center rounded-full border border-border",
                "transition-transform duration-200 ease-out hover:scale-110",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                // The "theme default" swatch has no colour of its own to show,
                // so it borrows the interface foreground — the same trick the
                // desktop's neutral swatch uses.
                color.value === null && "bg-foreground/85",
              )}
              data-testid={`accent-color-${color.name.toLowerCase().replace(/\s+/g, "-")}`}
              key={color.name}
              onClick={() => setAccent(color.value)}
              style={
                color.value === null
                  ? undefined
                  : { backgroundColor: color.value }
              }
              title={color.name}
              type="button"
            >
              {selected ? (
                <Check
                  aria-hidden="true"
                  className="size-4 text-background drop-shadow"
                  data-testid="accent-color-selection"
                  strokeWidth={3}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Used for selection, the active channel, and primary buttons. “Theme
        default” leaves the colours the theme itself chose.
      </p>
    </div>
  );
}
