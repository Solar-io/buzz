/**
 * Key bytes the terminal writes itself, PURE (phase-7.md §8 `ui/KeyBar.tsx`,
 * W-7). Two families:
 *
 *  1. The phone key bar (PhoneTerminal artboard): esc, tab, a ctrl LATCH and
 *     the four arrows. Arrow bytes depend on DECCKM (application cursor keys):
 *     a TUI on the alternate screen often sets it, and `ESC [ A` is then the
 *     WRONG byte — the button would silently do nothing. So the caller passes
 *     xterm's live `modes.applicationCursorKeysMode` and we pick.
 *  2. Chords xterm cannot produce (ported from evie-ui `term-keys.js` and the
 *     custom key handler in `term-xterm.js`): Cmd+K / Cmd+J as CSI-u SUPER
 *     chords (herdr next_tab / previous_tab), and Shift+Enter as ESC CR
 *     (Claude Code's "newline, don't submit").
 */

export type BarKey = "esc" | "tab" | "up" | "down" | "left" | "right";

const ARROW_FINAL: Record<"up" | "down" | "right" | "left", string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

/**
 * The bytes for one key-bar press.
 *
 *   esc  → ESC          tab → HT
 *   ↑    → ESC [ A, or ESC O A under DECCKM
 *   ctrl+↑ → ESC [ 1 ; 5 A (a modified arrow ignores DECCKM, as xterm does)
 *
 * ctrl on esc/tab changes nothing: there is no distinct byte to send.
 */
export function barKeyBytes(
  key: BarKey,
  options: { ctrl: boolean; appCursor: boolean },
): string {
  if (key === "esc") {
    return "\x1b";
  }
  if (key === "tab") {
    return "\t";
  }
  const final = ARROW_FINAL[key];
  if (options.ctrl) {
    return `\x1b[1;5${final}`;
  }
  return options.appCursor ? `\x1bO${final}` : `\x1b[${final}`;
}

/** Arrows repeat while held; esc and tab do not. */
export function barKeyRepeats(key: BarKey): boolean {
  return key !== "esc" && key !== "tab";
}

/**
 * Apply a latched ctrl to the NEXT typed character (soft keyboard input).
 * Returns the control byte, or null when the input has no ctrl form (the
 * caller then sends it unchanged and drops the latch).
 *
 *   a–z / A–Z → 0x01–0x1a (ctrl+c = ETX, the interrupt)
 *   @ [ \ ] ^ _ and space → 0x00, 0x1b–0x1f, 0x00
 *   ?         → DEL (0x7f)
 */
export function ctrlByte(data: string): string | null {
  if (data.length !== 1) {
    return null;
  }
  const code = data.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCharCode(code - 0x60);
  }
  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCharCode(code - 0x40);
  }
  if (code >= 0x40 && code <= 0x5f) {
    return String.fromCharCode(code - 0x40);
  }
  if (data === " ") {
    return "\x00";
  }
  if (data === "?") {
    return "\x7f";
  }
  return null;
}

/**
 * The ctrl latch: one press arms it, the next key consumes it. A second
 * press disarms it (the artboard shows ctrl as a toggle, `aria-pressed`).
 */
export interface CtrlLatch {
  readonly armed: boolean;
  toggle(): boolean;
  /** Consume the latch for a typed string: the bytes to actually send. */
  apply(data: string): string;
  /** Consume it for a bar key: whether ctrl applies to this press. */
  takeForBarKey(): boolean;
  clear(): void;
}

export function createCtrlLatch(
  onChange?: (armed: boolean) => void,
): CtrlLatch {
  let armed = false;
  const set = (next: boolean) => {
    if (armed !== next) {
      armed = next;
      onChange?.(armed);
    }
  };
  return {
    get armed() {
      return armed;
    },
    toggle() {
      set(!armed);
      return armed;
    },
    apply(data) {
      if (!armed) {
        return data;
      }
      set(false);
      return ctrlByte(data) ?? data;
    },
    takeForBarKey() {
      const was = armed;
      set(false);
      return was;
    },
    clear() {
      set(false);
    },
  };
}

/** The kitty-protocol modifier for a BARE Cmd/Super: 1 + super(8). */
export const CSIU_MOD_SUPER = 9;

/** One character as a CSI-u keypress carrying SUPER: `k` → ESC [ 107 ; 9 u. */
export function csiUSuper(ch: string): string {
  if ([...ch].length !== 1) {
    throw new Error(
      `csiUSuper expects one character (got ${JSON.stringify(ch)})`,
    );
  }
  return `\x1b[${ch.codePointAt(0)};${CSIU_MOD_SUPER}u`;
}

/**
 * herdr's Cmd chords. The letters must match `~/.config/herdr/config.toml`
 * on crichton (`next_tab = "cmd+k"`, `previous_tab = "cmd+j"`); this table
 * only guarantees the chord ARRIVES.
 */
export const HERDR_CMD_KEYS: Readonly<Record<string, string>> = Object.freeze({
  k: csiUSuper("k"),
  j: csiUSuper("j"),
});

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** BARE Cmd only: Cmd+Shift+K and friends fall through to xterm untouched. */
export function herdrCmdSeqFor(e: KeyLike | null | undefined): string | null {
  if (!e || typeof e.key !== "string") {
    return null;
  }
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
    return null;
  }
  return HERDR_CMD_KEYS[e.key.toLowerCase()] ?? null;
}

/** Bare Shift+Enter → ESC CR. xterm sends a bare CR for it, identical to Enter. */
export function shiftEnterSeqFor(e: KeyLike | null | undefined): string | null {
  if (e?.key !== "Enter") {
    return null;
  }
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
    return null;
  }
  return "\x1b\r";
}
