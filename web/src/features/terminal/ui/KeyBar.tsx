import { Keyboard } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "@/shared/lib/cn";
import { type BarKey, barKeyRepeats } from "../emulator/keys.ts";

/** A typical keyboard's initial delay, then a typical repeat rate. */
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

const KEYS: ReadonlyArray<{ key: BarKey; label: string; aria: string }> = [
  { key: "esc", label: "esc", aria: "Escape" },
  { key: "tab", label: "tab", aria: "Tab" },
];
const ARROWS: ReadonlyArray<{ key: BarKey; label: string; aria: string }> = [
  { key: "up", label: "↑", aria: "Up" },
  { key: "down", label: "↓", aria: "Down" },
  { key: "left", label: "←", aria: "Left" },
  { key: "right", label: "→", aria: "Right" },
];

/**
 * The terminal key bar (PhoneTerminal artboard; port of evie-ui `term-pad.js`):
 * esc, tab, a ctrl LATCH, the four arrows and the soft-keyboard key.
 *
 * Every key acts on POINTERDOWN with `preventDefault`, so pressing a key
 * never moves focus off xterm's helper textarea (that would drop the iOS
 * keyboard mid-command). Keyboard activation still works: a click with
 * `detail === 0` came from Enter/Space, not a pointer. The bar names KEYS;
 * the emulator decides the BYTES (DECCKM-aware arrows).
 */
export function KeyBar({
  onKey,
  ctrlArmed,
  onToggleCtrl,
  keyboard,
  onToggleKeyboard,
  className,
}: {
  onKey: (key: BarKey) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  /** Soft-keyboard state; omit to hide the key (fine-pointer desktop). */
  keyboard?: boolean;
  onToggleKeyboard?: () => void;
  className?: string;
}) {
  const repeat = useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    tick: ReturnType<typeof setInterval> | null;
  }>({ delay: null, tick: null });

  const stopRepeat = () => {
    const r = repeat.current;
    if (r.delay) clearTimeout(r.delay);
    if (r.tick) clearInterval(r.tick);
    r.delay = null;
    r.tick = null;
  };
  // A key held while the bar unmounts must not keep firing into the PTY.
  useEffect(() => {
    const r = repeat.current;
    return () => {
      if (r.delay) clearTimeout(r.delay);
      if (r.tick) clearInterval(r.tick);
    };
  }, []);

  const press = (key: BarKey) => {
    onKey(key);
    if (barKeyRepeats(key)) {
      stopRepeat();
      repeat.current.delay = setTimeout(() => {
        repeat.current.tick = setInterval(() => onKey(key), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    }
  };

  const keyClass =
    "h-10 min-w-0 rounded-lg bg-key font-mono text-xs text-foreground shadow-[0_1px_0_hsl(var(--line-2))] active:brightness-95 touch-manipulation select-none";

  const keyButton = (entry: { key: BarKey; label: string; aria: string }) => (
    <button
      key={entry.key}
      type="button"
      aria-label={entry.aria}
      data-testid={`key-${entry.key}`}
      className={keyClass}
      onPointerDown={(event) => {
        event.preventDefault();
        press(entry.key);
      }}
      onPointerUp={stopRepeat}
      onPointerCancel={stopRepeat}
      onPointerLeave={stopRepeat}
      onClick={(event) => {
        if (event.detail === 0) onKey(entry.key);
      }}
    >
      {entry.label}
    </button>
  );

  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      data-testid="terminal-keybar"
      className={cn(
        "grid gap-1.25 border-t border-border bg-chip px-2 pt-2",
        keyboard === undefined ? "grid-cols-7" : "grid-cols-8",
        className,
      )}
    >
      {KEYS.map(keyButton)}
      <button
        type="button"
        aria-label="Control"
        aria-pressed={ctrlArmed}
        data-testid="key-ctrl"
        className={cn(
          keyClass,
          ctrlArmed && "bg-foreground text-background shadow-none",
        )}
        onPointerDown={(event) => {
          event.preventDefault();
          onToggleCtrl();
        }}
        onClick={(event) => {
          if (event.detail === 0) onToggleCtrl();
        }}
      >
        ctrl
      </button>
      {ARROWS.map(keyButton)}
      {keyboard !== undefined && onToggleKeyboard ? (
        <button
          type="button"
          aria-label={keyboard ? "Hide keyboard" : "Show keyboard"}
          aria-pressed={keyboard}
          data-testid="key-keyboard"
          className={cn(
            keyClass,
            "grid place-items-center",
            keyboard && "bg-foreground text-background shadow-none",
          )}
          // iOS raises the keyboard only inside a trusted gesture, so this
          // must run synchronously in pointerdown.
          onPointerDown={(event) => {
            event.preventDefault();
            onToggleKeyboard();
          }}
          onClick={(event) => {
            if (event.detail === 0) onToggleKeyboard();
          }}
        >
          <Keyboard aria-hidden className="size-4.25" />
        </button>
      ) : null}
    </div>
  );
}
