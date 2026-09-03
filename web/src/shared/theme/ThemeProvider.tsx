import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { createThemeVars, hexToHsl, luminance } from "./adaptive-theme.ts";
import {
  BUZZ_DARK_THEME_NAME,
  BUZZ_THEME_NAME,
  type SyntaxThemeName,
  SYNTAX_THEMES,
  extractThemeInfo,
  isLightTheme,
  loadThemeData,
  resolveShikiThemeName,
  resolveSystemTheme,
} from "./theme-loader.ts";

/**
 * Theme provider.
 *
 * Themes are not hand-written palettes. A theme is a *syntax* theme, and the
 * whole interface palette is derived from its four key colours by
 * {@link createThemeVars} — the same engine the desktop client uses, ported in
 * `adaptive-theme.ts`. That is what makes the Catppuccin family (and ~50
 * others) available without transcribing a single value by hand.
 *
 * Three pieces of state, each persisted:
 *
 * - `themeName`  — the selected syntax theme.
 * - `followSystem` — when set, the selection is swapped for its light/dark
 *   partner to match the OS (see `THEME_PAIRS` in the loader).
 * - `accent` — an optional user accent. See {@link applyAccent} for why this
 *   is a separate layer rather than part of the derived set.
 */

export const THEME_STORAGE_KEY = "buzz-theme";
export const FOLLOW_SYSTEM_STORAGE_KEY = "buzz-follow-system";
export const ACCENT_STORAGE_KEY = "buzz-accent-color";
/**
 * First-paint cache. Loading a theme means a dynamic `import()` of its JSON,
 * which cannot happen before first paint — so without this the app renders
 * one frame in the stylesheet's default palette and then snaps to the real
 * one. Caching the derived variables lets us paint the right colours
 * immediately and reconcile once the real theme resolves.
 */
const THEME_CACHE_KEY = "buzz-theme-cache";

const DEFAULT_THEME: SyntaxThemeName = BUZZ_DARK_THEME_NAME;

/** Coarse light/dark selector, kept for callers that only need polarity. */
export type ThemeMode = "light" | "dark" | "system";

interface ThemeCache {
  name: string;
  isDark: boolean;
  vars: Record<string, string>;
}

export interface ThemeContextValue {
  /** Resolved polarity of the applied theme. */
  isDark: boolean;
  /** The user's selection, before any system swap. */
  themeName: string;
  /** The theme actually applied, after the system swap. */
  appliedThemeName: string;
  setThemeName: (name: string) => void;
  followSystem: boolean;
  setFollowSystem: (enabled: boolean) => void;
  /** Accent as a hex string, or null to leave the stylesheet's own values. */
  accent: string | null;
  setAccent: (hex: string | null) => void;
  /** Every selectable theme, for a picker. */
  availableThemes: readonly string[];
  /** Coarse light/dark/system control. */
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function systemPrefersDark(): boolean {
  return (
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  );
}

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage can throw outright in private windows and embedded webviews.
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) {
      globalThis.localStorage?.removeItem(key);
    } else {
      globalThis.localStorage?.setItem(key, value);
    }
  } catch {
    // Preference is session-local when storage is unavailable.
  }
}

function isKnownTheme(name: string | null): name is SyntaxThemeName {
  return name !== null && (SYNTAX_THEMES as readonly string[]).includes(name);
}

function initialThemeName(): SyntaxThemeName {
  const stored = readStored(THEME_STORAGE_KEY);
  return isKnownTheme(stored) ? stored : DEFAULT_THEME;
}

function initialFollowSystem(): boolean {
  // Default on: a first-run user should track their OS rather than be forced
  // into whichever polarity DEFAULT_THEME happens to be.
  return readStored(FOLLOW_SYSTEM_STORAGE_KEY) !== "false";
}

function readThemeCache(): ThemeCache | null {
  const raw = readStored(THEME_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ThemeCache;
    return parsed && typeof parsed === "object" && parsed.vars ? parsed : null;
  } catch {
    return null;
  }
}

/** Paint a derived variable set onto the document root. */
function applyVars(vars: Record<string, string>, isDark: boolean): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  root.classList.remove("light", "dark");
  root.classList.add(isDark ? "dark" : "light");
  root.style.colorScheme = isDark ? "dark" : "light";
}

/**
 * Pick readable text for a solid accent fill. Mirrors the desktop's contrast
 * choice: the WCAG relative luminance of the fill decides black or white.
 */
function accentForeground(hex: string): string {
  return luminance(hex) > 0.45 ? "0 0% 0%" : "0 0% 100%";
}

/**
 * Apply (or clear) the accent layer.
 *
 * The adaptive engine deliberately does NOT emit `--primary`,
 * `--sidebar-primary` or `--sidebar-active` — verified by
 * `adaptive-theme.test.mjs`, which fails if that ever changes. Those describe
 * *selection*, which is a user preference rather than a property of the
 * syntax theme, so they live here.
 *
 * Passing `null` removes the inline overrides rather than writing a default.
 * That matters: `globals.css` carries deliberate values for these — including
 * a specific selected-row purple — and an accent nobody asked for must not
 * silently replace them.
 */
function applyAccent(hex: string | null): void {
  const root = document.documentElement;
  const names = [
    "--primary",
    "--primary-foreground",
    "--sidebar-primary",
    "--sidebar-primary-foreground",
    "--sidebar-active",
    "--sidebar-active-foreground",
  ];

  if (hex === null) {
    for (const name of names) {
      root.style.removeProperty(name);
    }
    return;
  }

  const accentHsl = hexToHsl(hex);
  const foregroundHsl = accentForeground(hex);
  root.style.setProperty("--primary", accentHsl);
  root.style.setProperty("--primary-foreground", foregroundHsl);
  root.style.setProperty("--sidebar-primary", accentHsl);
  root.style.setProperty("--sidebar-primary-foreground", foregroundHsl);
  root.style.setProperty("--sidebar-active", accentHsl);
  root.style.setProperty("--sidebar-active-foreground", foregroundHsl);
}

/** Resolve, derive and apply a theme. Returns the cache entry it wrote. */
async function applyThemeByName(name: string): Promise<ThemeCache> {
  const shikiName = resolveShikiThemeName(name);
  const data = await loadThemeData(shikiName);
  const info = extractThemeInfo(name, data);
  const { isDark, vars } = createThemeVars(info.bg, info.fg, info.comment, {
    added: info.added,
    deleted: info.deleted,
    modified: info.modified,
  });
  applyVars(vars, isDark);
  return { name, isDark, vars };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeName, setThemeNameState] =
    useState<SyntaxThemeName>(initialThemeName);
  const [followSystem, setFollowSystemState] =
    useState<boolean>(initialFollowSystem);
  const [accent, setAccentState] = useState<string | null>(() =>
    readStored(ACCENT_STORAGE_KEY),
  );
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Optimistic first paint from the cache, before any dynamic import lands.
  const [isDark, setIsDark] = useState<boolean>(() => {
    const cached = readThemeCache();
    if (cached) {
      applyVars(cached.vars, cached.isDark);
      return cached.isDark;
    }
    // No cache: fall back to the selection's own polarity so the .dark class
    // is at least right, even though the derived vars are not applied yet.
    const initial = initialThemeName();
    const dark = initialFollowSystem()
      ? systemPrefersDark()
      : !isLightTheme(initial);
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(dark ? "dark" : "light");
    return dark;
  });

  const appliedThemeName = useMemo(
    () =>
      followSystem ? resolveSystemTheme(themeName, systemDark) : themeName,
    [followSystem, themeName, systemDark],
  );

  // Track the OS only while we are following it.
  useEffect(() => {
    if (!followSystem) return;
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [followSystem]);

  useEffect(() => {
    let cancelled = false;
    void applyThemeByName(appliedThemeName)
      .then((cache) => {
        if (cancelled) return;
        setIsDark(cache.isDark);
        writeStored(THEME_CACHE_KEY, JSON.stringify(cache));
      })
      .catch(() => {
        // A theme that fails to load leaves the previous one applied, which is
        // strictly better than clearing to an unstyled document.
      });
    return () => {
      cancelled = true;
    };
  }, [appliedThemeName]);

  // Independent of the theme effect on purpose: `applyVars` writes only what
  // the engine emits, and the engine emits none of the accent properties
  // (pinned by adaptive-theme.test.mjs). So a theme change cannot clobber the
  // accent, and this does not need to re-run when the theme does.
  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  const setThemeName = useCallback((name: string) => {
    if (!isKnownTheme(name)) return;
    setThemeNameState(name);
    writeStored(THEME_STORAGE_KEY, name);
  }, []);

  const setFollowSystem = useCallback((enabled: boolean) => {
    setFollowSystemState(enabled);
    writeStored(FOLLOW_SYSTEM_STORAGE_KEY, enabled ? "true" : "false");
  }, []);

  const setAccent = useCallback((hex: string | null) => {
    setAccentState(hex);
    writeStored(ACCENT_STORAGE_KEY, hex);
  }, []);

  const mode: ThemeMode = followSystem
    ? "system"
    : isLightTheme(themeName)
      ? "light"
      : "dark";

  /**
   * Coarse control for a light/dark/system toggle. Switching polarity keeps
   * the user's chosen theme family by moving to its pair where one exists —
   * so a Catppuccin Latte user gets Mocha, not some unrelated default.
   */
  const setMode = useCallback(
    (next: ThemeMode) => {
      if (next === "system") {
        setFollowSystem(true);
        return;
      }
      setFollowSystem(false);
      const wantLight = next === "light";
      if (isLightTheme(themeName) === wantLight) return;
      const paired = resolveSystemTheme(themeName, !wantLight);
      setThemeName(
        paired === themeName
          ? wantLight
            ? BUZZ_THEME_NAME
            : BUZZ_DARK_THEME_NAME
          : paired,
      );
    },
    [themeName, setFollowSystem, setThemeName],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      isDark,
      themeName,
      appliedThemeName,
      setThemeName,
      followSystem,
      setFollowSystem,
      accent,
      setAccent,
      availableThemes: SYNTAX_THEMES,
      mode,
      setMode,
    }),
    [
      isDark,
      themeName,
      appliedThemeName,
      setThemeName,
      followSystem,
      setFollowSystem,
      accent,
      setAccent,
      mode,
      setMode,
    ],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
