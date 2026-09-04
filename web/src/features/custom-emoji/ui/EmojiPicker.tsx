import { useEffect, useRef, useState } from "react";
import { PANEL_H, PANEL_W, placePanel } from "../lib/placePanel.ts";
import { EmojiPickerPanel } from "./EmojiPickerPanel";

/**
 * The one emoji picker for the app: search, categories, skin tones, the
 * community's custom emoji, and a GIF tab where the relay offers one.
 *
 * This file owns only the popover mechanics — anchoring, clamping, and the
 * close paths. The picker's contents are ./EmojiPickerPanel.tsx.
 *
 * Positioning is `fixed` against the anchor's measured rect rather than a
 * Radix popover, because both call sites live inside scrolling containers
 * (the message row's hover bar, the composer's toolbar) where an absolutely
 * positioned panel is clipped. That was true of the 48-glyph palette this
 * replaces and is unchanged.
 */

export function EmojiPicker({
  onSelect,
  onSelectGif,
  children,
  label,
}: {
  /** Chosen emoji as a string: a unicode glyph, or `:shortcode:`. */
  onSelect: (emoji: string) => void;
  /**
   * Insert a GIF as message markdown. Omitted by reaction call sites, which
   * hides the GIF tab — a NIP-25 reaction is one emoji, never an image.
   */
  onSelectGif?: (markdown: string) => void;
  /** The anchor element (usually a button) that opens the picker. */
  children: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    "aria-label": string;
  }) => React.ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        !panelRef.current?.contains(event.target as Node) &&
        !anchorRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!open && anchorRef.current) {
      setRect(anchorRef.current.getBoundingClientRect());
    }
    setOpen((value) => !value);
  };

  const position = placePanel(rect);

  return (
    <>
      {children({
        ref: anchorRef,
        onClick: toggle,
        "aria-label": label,
      })}
      {open && rect && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          data-testid="emoji-picker-panel"
          style={{ ...position, width: PANEL_W, height: PANEL_H }}
          className="fixed z-50 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
        >
          <EmojiPickerPanel
            onSelect={onSelect}
            onSelectGif={onSelectGif}
            onDone={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
