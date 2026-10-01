/**
 * Touch-device typing rules, PURE. Ported from evie-ui
 * `term-hardware-keyboard.js`, `term-soft-keyboard.js` and
 * `term-smart-period.js` (ADR-059 F2, ADR-080).
 *
 * On a coarse pointer, focusing xterm's helper textarea RAISES the iOS
 * keyboard, so the terminal never focuses itself on open — the key bar's
 * keyboard button does it, inside a trusted pointerdown. Two refinements:
 *  - a PHYSICAL keyboard (an iPad case) proves itself with a trusted keydown
 *    while nothing editable is focused; then the helper may hold focus with
 *    `inputMode: "none"` (types, shows no glass keyboard);
 *  - iOS's double-space period is lost (xterm forwards both spaces before
 *    WebKit's replacement edit), so the second space becomes DEL + ". ".
 */

const IME_KEYCODE = 229;

export function isEditableTarget(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/** A trusted keydown with nothing editable focused can only come from hardware. */
export function isHardwareKeydown(
  ev: { isTrusted?: boolean; key?: string; keyCode?: number } | null,
  activeElement: unknown,
): boolean {
  if (ev?.isTrusted !== true) return false;
  if (ev.keyCode === IME_KEYCODE) return false;
  if (typeof ev.key !== "string" || ev.key.length === 0) return false;
  return !isEditableTarget(activeElement);
}

export interface TypingState {
  coarse: boolean;
  hardwareKeyboard: boolean;
  softKeyboardRequested: boolean;
}

/** Desktop always focuses; a finger device only on request or with a proven keyboard. */
export function shouldFocusTerminal(s: TypingState): boolean {
  if (!s.coarse) return true;
  if (s.softKeyboardRequested) return true;
  return s.hardwareKeyboard;
}

/** Same rule for xterm's own incidental focus: keep it, or blur it back out. */
export const shouldKeepFocus = shouldFocusTerminal;

/** `"text"` on a focused helper SUMMONS the glass keyboard; a hardware-only user stays at `"none"`. */
export function inputModeFor(s: TypingState): "text" | "none" {
  if (s.softKeyboardRequested) return "text";
  return s.coarse ? "none" : "text";
}

/** "We have seen a physical keyboard on this page" — sticky, never persisted. */
export function createHardwareKeyboardLatch(onDetect?: () => void) {
  let seen = false;
  return {
    seen: () => seen,
    observe(
      ev: { isTrusted?: boolean; key?: string; keyCode?: number },
      activeElement: unknown,
    ): boolean {
      if (seen || !isHardwareKeydown(ev, activeElement)) return false;
      seen = true;
      try {
        onDetect?.();
      } catch {
        // Detection must never break key handling.
      }
      return true;
    },
  };
}

interface HelperTextarea {
  inputMode: string;
  focus(): void;
  blur(): void;
  setAttribute?(name: string, value: string): void;
  spellcheck?: boolean;
}

/** Opt xterm's helper back into iOS text traits (it disables them by default). */
export function configureSoftKeyboard(
  ta: HelperTextarea | null | undefined,
): void {
  if (!ta) return;
  ta.inputMode = "text";
  ta.setAttribute?.("autocapitalize", "sentences");
  ta.setAttribute?.("autocorrect", "on");
  ta.setAttribute?.("spellcheck", "true");
  if ("spellcheck" in ta) ta.spellcheck = true;
}

/** Raise (`show`) or dismiss the soft keyboard through the helper textarea. */
export function applySoftKeyboard(
  ta: HelperTextarea | null | undefined,
  show: boolean,
  options: { coarse: boolean; activeElement?: unknown },
): void {
  if (!ta) return;
  if (!show) {
    ta.blur();
    if (options.coarse) ta.inputMode = "none";
    return;
  }
  if (options.coarse) {
    // Every show is a fresh text-responder transition (WebKit's focus
    // bookkeeping and the keyboard's presentation can diverge).
    ta.blur();
    ta.inputMode = "none";
    configureSoftKeyboard(ta);
  } else if (options.activeElement === ta) {
    ta.blur();
  }
  ta.focus();
}

export const SMART_PERIOD_WINDOW_MS = 1_000;

/** Two individually-typed spaces within a second → DEL + ". " (coarse pointer only). */
export function reduceSmartPeriod(
  lastSpaceAt: number | null,
  data: string,
  nowMs: number,
  enabled: boolean,
): { data: string; lastSpaceAt: number | null } {
  if (!enabled || data !== " ") return { data, lastSpaceAt: null };
  if (
    lastSpaceAt !== null &&
    Number.isFinite(nowMs) &&
    nowMs >= lastSpaceAt &&
    nowMs - lastSpaceAt <= SMART_PERIOD_WINDOW_MS
  ) {
    return { data: "\x7f. ", lastSpaceAt: null };
  }
  return { data, lastSpaceAt: Number.isFinite(nowMs) ? nowMs : null };
}
