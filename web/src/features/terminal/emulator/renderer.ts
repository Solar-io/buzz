/**
 * The renderer chain: WebGL → Canvas → DOM. Ported from evie-ui
 * `term-xterm.js` (activateRenderer / attachWebgl / attachCanvas, ADR-030).
 *
 * xterm's default DOM renderer is never idle: the blinking cursor is a CSS
 * keyframe on colour and background, ~120 style recalcs a second at a silent
 * prompt. The GPU renderers draw it into a texture instead. But a renderer is
 * an optimization: every step here DEGRADES, none of them throws, and the
 * floor is xterm's built-in DOM renderer — a working terminal.
 *
 * ORDER: activate strictly AFTER `term.open()` (before it, WebglAddon defers
 * itself into open() and the "no WebGL2" throw escapes our try/catch) and
 * strictly AFTER the font gate (the glyph atlas is rasterized at activation).
 */

import { makeBoxGlyphFg } from "./glyphContrast.ts";
import {
  type XtermAddon,
  type XtermTerminal,
  xtermGlobals,
} from "./xtermTypes.ts";

/** Give up on WebGL after this many context losses and stay on Canvas. */
export const WEBGL_MAX_RECOVERIES = 3;
/**
 * herdr's split dividers are LIGHT box glyphs, which the GPU renderers draw at
 * 1 CSS px at every zoom. evie's patch in the vendored bundles multiplies the
 * light weight by this; must be set before construction (the atlas caches).
 */
export const TERM_BOX_LINE_SCALE = 2;
/** Lift box glyphs painted in ~the background colour to this contrast. */
export const TERM_BOX_MIN_CONTRAST = 2.1;

export type RendererKind = "webgl" | "canvas" | "dom";

/** Publish the box-glyph filter for the current background (re-run on every theme change). */
export function syncBoxGlyphs(background: string): void {
  const g = xtermGlobals();
  g.__evieBoxLineScale = TERM_BOX_LINE_SCALE;
  g.__evieBoxGlyphFg = makeBoxGlyphFg({
    background,
    minContrast: TERM_BOX_MIN_CONTRAST,
  });
}

export class RendererChain {
  private renderer: XtermAddon | null = null;
  private webglRecoveries = 0;
  private disposed = false;
  kind: RendererKind = "dom";
  private readonly term: XtermTerminal;
  private readonly onChange?: (kind: RendererKind) => void;

  // No parameter properties: the node test runner strips types only.
  constructor(term: XtermTerminal, onChange?: (kind: RendererKind) => void) {
    this.term = term;
    this.onChange = onChange;
  }

  activate(): RendererKind {
    if (this.attachWebgl() || this.attachCanvas()) {
      return this.kind;
    }
    // Both GPU paths refused: the DOM renderer is already installed.
    this.set("dom", null);
    return this.kind;
  }

  private set(kind: RendererKind, addon: XtermAddon | null) {
    this.kind = kind;
    this.renderer = addon;
    this.onChange?.(kind);
  }

  private attachWebgl(): boolean {
    const Ctor = xtermGlobals().WebglAddon?.WebglAddon;
    if (!Ctor) {
      return false;
    }
    let addon: InstanceType<typeof Ctor> | null = null;
    try {
      addon = new Ctor();
      // Throws synchronously when the browser will not hand out a WebGL2
      // context, before the addon swaps itself in.
      this.term.loadAddon(addon);
    } catch (error) {
      try {
        addon?.dispose();
      } catch {
        // Nothing to unwind.
      }
      console.warn("[term] WebGL renderer unavailable — trying canvas.", error);
      return false;
    }
    const live = addon;
    // A lost context left installed paints into nothing: a silently BLANK
    // terminal. Dispose (xterm reinstates DOM + a full repaint), then climb
    // back, bounded — a wedged GPU would otherwise churn contexts forever.
    live.onContextLoss(() => {
      console.warn("[term] WebGL context lost — restoring on a CPU renderer.");
      live.dispose();
      this.set("dom", null);
      setTimeout(() => {
        if (this.disposed || this.renderer) {
          return;
        }
        if (
          this.webglRecoveries++ < WEBGL_MAX_RECOVERIES &&
          this.attachWebgl()
        ) {
          return;
        }
        this.attachCanvas();
      }, 0);
    });
    this.set("webgl", live);
    return true;
  }

  private attachCanvas(): boolean {
    const Ctor = xtermGlobals().CanvasAddon?.CanvasAddon;
    if (!Ctor) {
      return false;
    }
    let addon: XtermAddon | null = null;
    try {
      addon = new Ctor();
      this.term.loadAddon(addon);
    } catch (error) {
      try {
        addon?.dispose();
      } catch {
        // Nothing to unwind.
      }
      console.warn(
        "[term] Canvas renderer unavailable — staying on DOM.",
        error,
      );
      return false;
    }
    this.set("canvas", addon);
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }
}
