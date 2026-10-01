/**
 * Everything that turns a user gesture into PTY bytes. Ported from evie-ui
 * `term-xterm.js` (bootTerminal's handlers, installTouchScroll,
 * installPasteUpload, the custom key handler, the F2 focus gate).
 *
 * Listener options here are load-bearing; read the comments before tidying.
 */

import {
  applySoftKeyboard,
  configureSoftKeyboard,
  createHardwareKeyboardLatch,
  inputModeFor,
  reduceSmartPeriod,
  shouldFocusTerminal,
  shouldKeepFocus,
  type TypingState,
} from "./device.ts";
import { type CtrlLatch, herdrCmdSeqFor, shiftEnterSeqFor } from "./keys.ts";
import { clipboardHasFiles, uploadAndBuildPaste } from "./pasteUpload.ts";
import {
  drainNotches,
  fingerDeltaUp,
  isWithinSlop,
  MAX_NOTCHES_PER_MOVE,
  resolveNotchPx,
  TOUCH_SLOP_PX,
  wheelDeltaY,
} from "./touch.ts";
import type { XtermTerminal } from "./xtermTypes.ts";

export interface InputDeps {
  term: XtermTerminal;
  /** The element xterm was opened into. */
  screen: HTMLElement;
  /** Write bytes to the PTY; false when the socket is not open. */
  send(data: string | Uint8Array): boolean;
  ctrl: CtrlLatch;
  /** Upload one pasted file, resolving to its absolute path on crichton. */
  upload?(file: File, name: string): Promise<string>;
  /** A one-line notice for the page (upload progress / failure). */
  notice?(text: string, tone: "info" | "error"): void;
}

const coarsePointer = () =>
  globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;

export interface InputHandle {
  /** Raise (true) / dismiss (false) the soft keyboard — call inside a trusted pointerdown. */
  setSoftKeyboard(show: boolean): void;
  /** Focus per the F2 rules (desktop always; a finger device only when it may). */
  focusIfAllowed(): void;
  dispose(): void;
}

export function installInput(deps: InputDeps): InputHandle {
  const { term, screen } = deps;
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  let softKeyboardRequested = false;
  const typing = (): TypingState => ({
    coarse: coarsePointer(),
    hardwareKeyboard: hardwareKeyboard.seen(),
    softKeyboardRequested,
  });
  const focusForTyping = () => {
    const ta = term.textarea;
    if (!ta) return;
    ta.inputMode = inputModeFor(typing());
    ta.focus();
  };
  const hardwareKeyboard = createHardwareKeyboardLatch(() => {
    if (screen.isConnected) focusForTyping();
  });
  // GLOBAL, capture, passive, never consumes: a physical keyboard announces
  // itself on its first key anywhere, so the terminal can focus on open.
  const detect = (ev: KeyboardEvent) =>
    hardwareKeyboard.observe(ev, document.activeElement);
  document.addEventListener("keydown", detect, {
    capture: true,
    passive: true,
  });
  cleanups.push(() =>
    document.removeEventListener("keydown", detect, { capture: true }),
  );

  /* The F2 focus gate (coarse pointer only): xterm may focus its helper
   * during open() or a tap; on a finger device that raises iOS, so any focus
   * the key bar did not ask for is blurred straight back out. */
  if (coarsePointer() && term.textarea) {
    const ta = term.textarea;
    configureSoftKeyboard(ta);
    const gate = () => {
      if (!shouldKeepFocus(typing())) ta.blur();
    };
    ta.addEventListener("focus", gate);
    cleanups.push(() => ta.removeEventListener("focus", gate));
    applySoftKeyboard(ta, false, { coarse: true });
  }

  /* Global shortcuts (⌘K Jump, Escape) must not fire while the terminal
   * owns the keyboard: Ctrl+K is kill-line in a shell, Escape is a key in
   * vim. Bubble phase on an ancestor: xterm (on its textarea) has already
   * handled the key; we only stop it reaching window. */
  on(screen, "keydown", (ev) => ev.stopPropagation());

  /* Right-click belongs to the TUI while one is asking for the mouse
   * (herdr's menu); Shift+right-click is the escape hatch to the browser's. */
  on(screen, "contextmenu", (ev) => {
    if (ev.shiftKey) return;
    if (term.modes.mouseTrackingMode === "none") return;
    ev.preventDefault();
  });

  installTouchScroll(term, screen, on);

  /* Paste a FILE: capture phase on an ANCESTOR of xterm's textarea, so this
   * runs before xterm's own handler. A TEXT paste returns untouched. */
  let pasteBusy = false;
  on(
    screen,
    "paste",
    (ev) => {
      if (!clipboardHasFiles(ev.clipboardData)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const upload = deps.upload;
      if (!upload || pasteBusy) return;
      const files = Array.from(ev.clipboardData?.files ?? []);
      if (files.length === 0) return;
      pasteBusy = true;
      deps.notice?.(
        `Uploading ${files.length === 1 ? files[0]?.name || "file" : `${files.length} files`}…`,
        "info",
      );
      void uploadAndBuildPaste(files, upload)
        .then((outcome) => {
          if (outcome.failed.length > 0) {
            deps.notice?.(
              `Upload failed: ${outcome.failed.map((f) => `${f.name} (${f.error})`).join(", ")}`,
              "error",
            );
          }
          if (outcome.bytes && !deps.send(outcome.bytes)) {
            deps.notice?.(
              `Uploaded, but the terminal is disconnected — ${outcome.paths[0]}`,
              "error",
            );
          } else if (outcome.bytes && outcome.failed.length === 0) {
            deps.notice?.("", "info");
          }
        })
        .finally(() => {
          pasteBusy = false;
        });
    },
    { capture: true },
  );

  /* Chords xterm cannot produce. `preventDefault` is load-bearing: without
   * it the browser still fires keypress and xterm sends its own CR after
   * our ESC CR — a newline immediately followed by a submit. */
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const seq = herdrCmdSeqFor(ev) ?? shiftEnterSeqFor(ev);
    if (!seq) return true;
    ev.preventDefault();
    deps.send(seq);
    return false;
  });

  let lastSpaceAt: number | null = null;
  const dataSub = term.onData((data) => {
    const next = reduceSmartPeriod(
      lastSpaceAt,
      data,
      Date.now(),
      coarsePointer(),
    );
    lastSpaceAt = next.lastSpaceAt;
    deps.send(deps.ctrl.apply(next.data));
  });
  // Mouse reports etc.: already bytes-as-latin1, not text.
  const binarySub = term.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    deps.send(bytes);
  });
  cleanups.push(
    () => dataSub.dispose(),
    () => binarySub.dispose(),
  );

  return {
    setSoftKeyboard(show) {
      softKeyboardRequested = show;
      applySoftKeyboard(term.textarea, show, {
        coarse: coarsePointer(),
        activeElement: document.activeElement,
      });
    },
    focusIfAllowed() {
      if (shouldFocusTerminal(typing())) focusForTyping();
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/**
 * Touch drag → synthetic WheelEvents xterm already listens for (ADR-032), so
 * the bytes are the trackpad's by construction. Engaged only while a TUI
 * asks for the mouse — exactly when xterm's own touch handlers are dead.
 *
 *  - touchstart MUST stay passive: cancelling it stops iOS synthesizing the
 *    click that focuses xterm and raises the keyboard.
 *  - touchmove MUST be non-passive, or preventDefault is ignored and iOS
 *    rubber-bands under our wheel reports.
 *  - 2+ fingers abort: a pinch must never scroll a live agent's TUI.
 *  - No momentum: phantom notches after lift-off could land in another agent.
 */
function installTouchScroll(
  term: XtermTerminal,
  screen: HTMLElement,
  on: <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => void,
) {
  const touch = {
    latched: false,
    moved: false,
    accum: 0,
    notchPx: 0,
    startX: 0,
    startY: 0,
    lastY: 0,
  };
  const abort = () => {
    touch.latched = false;
    touch.moved = false;
    touch.accum = 0;
  };
  const trackingOn = () => term.modes.mouseTrackingMode !== "none";

  on(
    screen,
    "touchstart",
    (ev) => {
      const t = ev.touches[0];
      if (ev.touches.length > 1 || !t) {
        abort();
        return;
      }
      touch.latched = trackingOn();
      touch.moved = false;
      touch.accum = 0;
      const screenEl = term.element?.querySelector(".xterm-screen");
      const height = screenEl?.getBoundingClientRect().height ?? 0;
      touch.notchPx = resolveNotchPx(height, term.rows);
      touch.startX = t.clientX;
      touch.startY = t.clientY;
      touch.lastY = t.clientY;
    },
    { passive: true },
  );

  on(
    screen,
    "touchmove",
    (ev) => {
      if (!touch.latched) return;
      const t = ev.touches[0];
      if (ev.touches.length > 1 || !t) {
        abort();
        return;
      }
      const dy = fingerDeltaUp(touch.lastY, t.clientY);
      touch.lastY = t.clientY;
      if (!touch.moved) {
        if (
          isWithinSlop(
            t.clientX - touch.startX,
            t.clientY - touch.startY,
            TOUCH_SLOP_PX,
          )
        ) {
          return;
        }
        touch.moved = true;
      }
      if (ev.cancelable) ev.preventDefault();
      touch.accum += dy;
      const drained = drainNotches(
        touch.accum,
        touch.notchPx,
        MAX_NOTCHES_PER_MOVE,
      );
      touch.accum = drained.accum;
      const el = term.element;
      for (let i = 0; i < drained.count && el; i++) {
        el.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: t.clientX,
            clientY: t.clientY,
            deltaX: 0,
            deltaY: wheelDeltaY(drained.dir),
            deltaZ: 0,
            // DOM_DELTA_LINE; all four modifiers false (shift suppresses the report).
            deltaMode: 1,
          }),
        );
      }
    },
    { passive: false },
  );

  on(screen, "touchend", abort, { passive: true });
  on(screen, "touchcancel", abort, { passive: true });
}
