/**
 * The slice of xterm 5.5's API the emulator uses. xterm ships UMD only and
 * is loaded as vendored <script> tags (assets.ts), so there is no npm type
 * package to import — this is written by hand against the 5.5 typings.
 */

import type { XtermTheme } from "./theme.ts";

export interface XtermDisposable {
  dispose(): void;
}

export interface XtermModes {
  applicationCursorKeysMode: boolean;
  bracketedPasteMode: boolean;
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
}

export interface XtermBufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface XtermTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly modes: XtermModes;
  readonly buffer: {
    active: { length: number; getLine(y: number): XtermBufferLine | undefined };
  };
  options: { theme?: Partial<XtermTheme> } & Record<string, unknown>;
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array): void;
  reset(): void;
  focus(): void;
  dispose(): void;
  loadAddon(addon: XtermAddon): void;
  onData(listener: (data: string) => void): XtermDisposable;
  onBinary(listener: (data: string) => void): XtermDisposable;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  clearTextureAtlas?(): void;
}

export interface XtermAddon extends XtermDisposable {
  activate?(terminal: XtermTerminal): void;
}

export interface FitAddon extends XtermAddon {
  fit(): void;
}

export interface WebglAddon extends XtermAddon {
  onContextLoss(listener: () => void): XtermDisposable;
}

export interface ClipboardProvider {
  readText(selection: string): string | Promise<string>;
  writeText(selection: string, text: string): void | Promise<void>;
}

/** The globals the UMD bundles install on `window`. */
export interface XtermGlobals {
  Terminal?: new (options: Record<string, unknown>) => XtermTerminal;
  FitAddon?: { FitAddon: new () => FitAddon };
  ClipboardAddon?: {
    ClipboardAddon: new (
      base64: unknown,
      provider: ClipboardProvider,
    ) => XtermAddon;
    Base64: new () => unknown;
  };
  WebglAddon?: { WebglAddon: new () => WebglAddon };
  CanvasAddon?: { CanvasAddon: new () => XtermAddon };
  /** Read at DRAW time by evie's patch in the vendored renderer bundles. */
  __evieBoxLineScale?: number;
  __evieBoxGlyphFg?: (css: string) => string;
}

export function xtermGlobals(): XtermGlobals {
  return globalThis as unknown as XtermGlobals;
}
