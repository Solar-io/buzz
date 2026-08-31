import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * Common-emoji palette used by the reaction hover action and the composer.
 * Fixed-positioned against the anchor button's rect (parents often scroll),
 * clamped to the viewport, closed by outside click or Esc.
 */

const EMOJI = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "😢",
  "🔥",
  "🚀",
  "👀",
  "✅",
  "❌",
  "💡",
  "🙏",
  "👏",
  "💪",
  "🤝",
  "😀",
  "😅",
  "🥰",
  "😎",
  "🤔",
  "🫡",
  "😴",
  "🤖",
  "😍",
  "😭",
  "🤯",
  "🥳",
  "😱",
  "🤦",
  "🤷",
  "💀",
  "💯",
  "⭐",
  "☕",
  "🍕",
  "🍻",
  "🎯",
  "⚠️",
  "🔗",
  "📌",
  "📈",
  "🧠",
  "🛠️",
  "🐛",
  "⚡",
  "🌈",
  "🐙",
];

export function EmojiPicker({
  onSelect,
  children,
  label,
}: {
  onSelect: (emoji: string) => void;
  /** The anchor element (usually a button) that opens the palette. */
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

  const PANEL_W = 264;
  const PANEL_H = 200;
  const left = rect
    ? Math.max(8, Math.min(rect.left, globalThis.innerWidth - PANEL_W - 8))
    : 0;
  // Prefer opening above the anchor (both call sites sit near the bottom of
  // the viewport); fall below when there is no room above.
  const top = rect
    ? rect.top > PANEL_H + 16
      ? rect.top - PANEL_H - 8
      : Math.min(rect.bottom + 8, globalThis.innerHeight - PANEL_H - 8)
    : 0;

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
          role="menu"
          aria-label="Emoji"
          style={{ left, top, width: PANEL_W }}
          className="fixed z-50 grid grid-cols-8 gap-0.5 rounded-lg border border-border bg-popover p-2 shadow-lg"
        >
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded text-lg",
                "hover:bg-accent",
              )}
              onClick={() => {
                onSelect(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
