/**
 * Mount / dispose / public API of the terminal emulator (phase-7.md §8
 * `emulator/boot.ts`). The React side (`ui/Xterm.tsx`) calls `mountTerminal`
 * once and holds the handle; nothing here keeps React state per byte.
 *
 * Boot order is the invariant, not the shape (evie-ui term-xterm.js):
 *   1. vendored bundles + the Nerd Font, in parallel, BOTH awaited
 *   2. the box-glyph filter published (the GPU atlas caches glyphs)
 *   3. new Terminal → fit → clipboard (write-only) → open
 *   4. input handlers, then the renderer chain (after open, after the font)
 *   5. the socket
 */

import { loadTermFont, loadXtermAssets, TERM_FONT_STACK } from "./assets.ts";
import { installInput, type InputHandle } from "./input.ts";
import { barKeyBytes, type BarKey, createCtrlLatch } from "./keys.ts";
import type { TermState } from "./protocol.ts";
import { RendererChain, type RendererKind, syncBoxGlyphs } from "./renderer.ts";
import { buildTermTheme, isDarkMode, readTermTokens } from "./theme.ts";
import { type RefusalVerdict, TermTransport } from "./transport.ts";
import {
  type ClipboardProvider,
  type FitAddon,
  type XtermTerminal,
  xtermGlobals,
} from "./xtermTypes.ts";

export interface MountOptions {
  /** `wss://…/ws/term?…` for a query. */
  socketUrl(query: URLSearchParams): string;
  onState(state: TermState): void;
  diagnose(): Promise<RefusalVerdict>;
  upload?(file: File, name: string): Promise<string>;
  onNotice?(text: string, tone: "info" | "error"): void;
  onCtrlChange?(armed: boolean): void;
  onRenderer?(kind: RendererKind): void;
  fontSize?: number;
}

export interface TerminalHandle {
  /** Reset view: soft reset (4002) on the shared session. Never kills the shell. */
  reset(): boolean;
  /** Try again after a terminal state (signed-out, at-capacity, …). */
  retry(): void;
  pressBarKey(key: BarKey): boolean;
  toggleCtrl(): boolean;
  setSoftKeyboard(show: boolean): void;
  focus(): void;
  /** The visible buffer as text (tests, debugging). */
  text(): string;
  dispose(): void;
}

export const DEFAULT_FONT_SIZE = 12.5;
const FIT_DEBOUNCE_MS = 50;

export function mountTerminal(
  mount: HTMLElement,
  options: MountOptions,
): TerminalHandle {
  let disposed = false;
  let term: XtermTerminal | null = null;
  let fit: FitAddon | null = null;
  let input: InputHandle | null = null;
  let chain: RendererChain | null = null;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanups: Array<() => void> = [];

  const ctrl = createCtrlLatch((armed) => options.onCtrlChange?.(armed));

  const transport = new TermTransport({
    url: options.socketUrl,
    sink: {
      write: (bytes) => term?.write(bytes),
      reset: () => term?.reset(),
    },
    geometry: () => (term ? { cols: term.cols, rows: term.rows } : null),
    onState: options.onState,
    diagnose: options.diagnose,
    onOpen: () => {
      refit();
      input?.focusIfAllowed();
    },
  });

  /** Fit, then tell the PTY. A timer, not rAF: rAF never fires in a hidden tab. */
  const refit = () => {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (!term || !fit || mount.clientHeight <= 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      transport.resize(term.cols, term.rows);
    }, FIT_DEBOUNCE_MS);
  };

  const applyTheme = () => {
    if (!term) return;
    const theme = buildTermTheme(readTermTokens(), isDarkMode());
    syncBoxGlyphs(theme.background);
    term.options.theme = theme;
    term.clearTextureAtlas?.();
  };

  async function boot() {
    const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    try {
      await Promise.all([loadXtermAssets(), loadTermFont(fontSize)]);
    } catch {
      if (!disposed) {
        options.onNotice?.("Terminal assets failed to load.", "error");
        options.onState("failed");
      }
      return;
    }
    if (disposed) return;
    const g = xtermGlobals();
    const Terminal = g.Terminal;
    const Fit = g.FitAddon?.FitAddon;
    if (!Terminal || !Fit) {
      options.onNotice?.("Terminal assets failed to load.", "error");
      options.onState("failed");
      return;
    }
    const theme = buildTermTheme(readTermTokens(), isDarkMode());
    syncBoxGlyphs(theme.background);
    term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      fontFamily: TERM_FONT_STACK,
      fontSize,
      // A right-click is a message to the TUI, not a word selection.
      rightClickSelectsWord: false,
      theme,
    });
    fit = new Fit();
    term.loadAddon(fit);

    // OSC 52: WRITE-enabled (an in-terminal copy reaches the browser
    // clipboard), READ-disabled (no program may pull the clipboard back).
    const Clip = g.ClipboardAddon;
    if (Clip) {
      const provider: ClipboardProvider = {
        readText: () => "",
        writeText: (selection, text) => {
          if (selection !== "c" || !navigator.clipboard?.writeText) return;
          return navigator.clipboard.writeText(text);
        },
      };
      term.loadAddon(new Clip.ClipboardAddon(new Clip.Base64(), provider));
    }

    const screen = document.createElement("div");
    screen.className = "buzz-term-screen";
    screen.dataset.testid = "terminal-screen";
    // FitAddon measures the element xterm opens INTO. `touch-action: none`
    // keeps touchmove cancelable for the touch→wheel bridge (input.ts).
    screen.style.cssText = "height:100%;width:100%;touch-action:none";
    mount.appendChild(screen);
    term.open(screen);

    input = installInput({
      term,
      screen,
      send: (data) => transport.send(data),
      ctrl,
      upload: options.upload,
      notice: options.onNotice,
    });
    chain = new RendererChain(term, (kind) => {
      // Observable without devtools: which renderer actually came up.
      mount.dataset.renderer = kind;
      options.onRenderer?.(kind);
    });
    chain.activate();

    const resizeObserver = new ResizeObserver(() => refit());
    resizeObserver.observe(mount);
    cleanups.push(() => resizeObserver.disconnect());

    // Re-theme on a light/dark switch (ThemeProvider flips the class).
    const themeObserver = new MutationObserver(() => applyTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-palette", "style"],
    });
    cleanups.push(() => themeObserver.disconnect());

    refit();
    transport.connect();
  }

  void boot();

  const handle: TerminalHandle = {
    reset: () => transport.reset(),
    retry: () => transport.retry(),
    pressBarKey(key) {
      const withCtrl = ctrl.takeForBarKey();
      return transport.send(
        barKeyBytes(key, {
          ctrl: withCtrl,
          appCursor: term?.modes.applicationCursorKeysMode ?? false,
        }),
      );
    },
    toggleCtrl: () => ctrl.toggle(),
    setSoftKeyboard: (show) => input?.setSoftKeyboard(show),
    focus: () => term?.focus(),
    text() {
      if (!term) return "";
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buffer.length; y++) {
        lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    },
    dispose() {
      disposed = true;
      if (fitTimer) clearTimeout(fitTimer);
      transport.dispose();
      for (const cleanup of cleanups.splice(0)) cleanup();
      input?.dispose();
      chain?.dispose();
      term?.dispose();
      term = null;
      mount.replaceChildren();
    },
  };
  // An element-scoped handle (not a window global) for e2e and debugging.
  (mount as HTMLElement & { buzzTerminal?: TerminalHandle }).buzzTerminal =
    handle;
  return handle;
}
